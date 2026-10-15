import { NewerDataError } from '../core/jsonl.ts';
import type { Clock, Mutex } from '../core/lock.ts';
import { EVENT_VERSION, type CreateEvent, type RegisterEvent, type StatusEvent, type TaskFields, type UpdateEvent } from './events.ts';
import { foldEvents, taskNumber, type Task } from './fold.ts';
import { NO_SKILL, type AddInput, type RegisterPolicy, type StatusInput, type Verdict } from './policy.ts';
import { isWritable, type RegisterSnapshot } from './snapshot.ts';
import type { EventLog } from './store.ts';

/** Tells whether a skill exists, so `done --skill <name>` cannot cite one that was never written. */
export interface SkillCatalog {
  exists(name: string): Promise<boolean>;
}

export interface RegisterDeps {
  readonly log: EventLog;
  readonly mutex: Mutex;
  readonly clock: Clock;
  readonly policy: RegisterPolicy;
  readonly skills: SkillCatalog;
}

export interface WriteResult {
  readonly task: Task;
  readonly event: RegisterEvent;
}

/**
 * The register's write path: under the lock, read the log, replay it, apply the team policy,
 * append one event and return the task as it now stands. Reads take no lock.
 */
export class Register {
  private readonly deps: RegisterDeps;

  constructor(deps: RegisterDeps) {
    this.deps = deps;
  }

  /** The working set, read without the lock, as every read is. */
  snapshot(): Promise<RegisterSnapshot> {
    return this.deps.log.read();
  }

  /** Every task ever written, for a reader the working set cannot serve (layout.ts). */
  history(): Promise<RegisterSnapshot> {
    return this.deps.log.readHistory();
  }

  add(caller: string, input: AddInput): Promise<Verdict<WriteResult>> {
    return this.commit(caller, ({ state }) => this.created(caller, state.nextId, this.deps.policy.add(input, state)));
  }

  /**
   * A task from the parent team's lead, `parentLead` being its `<team>/<id>`. The tree's rules decide
   * who that may be, so this team's roster check is skipped; the event names that lead as its writer.
   */
  addFromParent(parentLead: string, input: AddInput): Promise<Verdict<WriteResult>> {
    return this.write(({ state }) => this.created(parentLead, state.nextId, this.deps.policy.addFromParent(input, state)));
  }

  async setStatus(caller: string, id: string, input: StatusInput): Promise<Verdict<WriteResult>> {
    const skill = input.skill?.trim();
    const skillExists = skill === undefined || skill === '' || skill === NO_SKILL || (await this.deps.skills.exists(skill));
    return this.commit(caller, (snapshot) =>
      onTask(snapshot, id, (task) => {
        const change = this.deps.policy.setStatus(task, caller, input, skillExists);
        if (!change.ok) {
          return change;
        }
        const event: StatusEvent = { ...this.base(id, caller), type: 'status', ...change.value };
        return { ok: true, value: event };
      }),
    );
  }

  update(caller: string, id: string, changes: Partial<TaskFields>, note: string | undefined): Promise<Verdict<WriteResult>> {
    return this.commit(caller, (snapshot) =>
      onTask(snapshot, id, (task) => {
        const change = this.deps.policy.update(task, caller, changes, note);
        if (!change.ok) {
          return change;
        }
        const event: UpdateEvent = { ...this.base(id, caller), type: 'update', ...change.value };
        return { ok: true, value: event };
      }),
    );
  }

  private created(by: string, id: string, fields: Verdict<TaskFields>): Verdict<RegisterEvent> {
    if (!fields.ok) {
      return fields;
    }
    const event: CreateEvent = { ...this.base(id, by), type: 'create', task: fields.value };
    return { ok: true, value: event };
  }

  private base(id: string, by: string): { v: number; id: string; at: string; by: string } {
    return { v: EVENT_VERSION, id, at: new Date(this.deps.clock.now()).toISOString(), by };
  }

  /** A write by a session of this team: refused unless the caller is on the roster. */
  private async commit(caller: string, decide: (snapshot: RegisterSnapshot) => Verdict<RegisterEvent>): Promise<Verdict<WriteResult>> {
    const callerProblem = this.deps.policy.checkCaller(caller);
    if (callerProblem !== undefined) {
      return { ok: false, error: callerProblem };
    }
    return this.write(decide);
  }

  /** Under the lock: refuse newer data, read the working set, decide on one event, append it, return the task after it. */
  private write(decide: (snapshot: RegisterSnapshot) => Verdict<RegisterEvent>): Promise<Verdict<WriteResult>> {
    return this.deps.mutex.run(async () => {
      const snapshot = await this.deps.log.read();
      if (!isWritable(snapshot.read)) {
        throw new NewerDataError(this.deps.log.path, snapshot.read.newestVersion, EVENT_VERSION);
      }
      const decision = decide(snapshot);
      if (!decision.ok) {
        return decision;
      }
      const event = decision.value;
      await this.deps.log.append(event);
      const task = foldEvents([event], [], snapshot.state).tasks.get(event.id);
      if (task === undefined) {
        throw new Error(`${event.id} is missing after its own write`);
      }
      return { ok: true, value: { task, event } };
    });
  }
}

/**
 * The decision on a task of the working set. An id below the next one that is not in it may be a task a
 * compaction retired: it is named as such, as this teamrig changes only tasks in the working set.
 */
function onTask(snapshot: RegisterSnapshot, id: string, decide: (task: Task) => Verdict<RegisterEvent>): Verdict<RegisterEvent> {
  const task = snapshot.state.tasks.get(id);
  if (task !== undefined) {
    return decide(task);
  }
  const archived = snapshot.retired !== null && taskNumber(id) < taskNumber(snapshot.state.nextId);
  return { ok: false, error: archived ? `no task ${id} in the working set: if it was finished long ago it is archived (teamrig show ${id})` : `no task ${id}` };
}
