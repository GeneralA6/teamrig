import { NewerDataError } from '../core/jsonl.ts';
import type { Clock, Mutex } from '../core/lock.ts';
import { EVENT_VERSION, type CreateEvent, type RegisterEvent, type StatusEvent, type TaskFields, type UpdateEvent } from './events.ts';
import { foldEvents, type RegisterState, type Task } from './fold.ts';
import { NO_SKILL, type AddInput, type RegisterPolicy, type StatusInput, type Verdict } from './policy.ts';
import { isWritable, type EventLog, type EventLogRead } from './store.ts';

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

export interface RegisterSnapshot {
  readonly state: RegisterState;
  readonly read: EventLogRead;
}

export interface WriteResult {
  readonly task: Task;
  readonly event: RegisterEvent;
}

/** The register as it stands, read without the lock, as every read is. */
export async function readSnapshot(log: EventLog): Promise<RegisterSnapshot> {
  const read = await log.read();
  return { state: foldEvents(read.events, read.seenIds), read };
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

  snapshot(): Promise<RegisterSnapshot> {
    return readSnapshot(this.deps.log);
  }

  add(caller: string, input: AddInput): Promise<Verdict<WriteResult>> {
    return this.commit(caller, (state) => this.created(caller, state, this.deps.policy.add(input, state)));
  }

  /**
   * A task from the parent team's lead, `parentLead` being its `<team>/<id>`. The tree's rules decide
   * who that may be, so this team's roster check is skipped; the event names that lead as its writer.
   */
  addFromParent(parentLead: string, input: AddInput): Promise<Verdict<WriteResult>> {
    return this.write((state) => this.created(parentLead, state, this.deps.policy.addFromParent(input, state)));
  }

  async setStatus(caller: string, id: string, input: StatusInput): Promise<Verdict<WriteResult>> {
    const skill = input.skill?.trim();
    const skillExists = skill === undefined || skill === '' || skill === NO_SKILL || (await this.deps.skills.exists(skill));
    return this.commit(caller, (state) =>
      onTask(state, id, (task) => {
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
    return this.commit(caller, (state) =>
      onTask(state, id, (task) => {
        const change = this.deps.policy.update(task, caller, changes, note);
        if (!change.ok) {
          return change;
        }
        const event: UpdateEvent = { ...this.base(id, caller), type: 'update', ...change.value };
        return { ok: true, value: event };
      }),
    );
  }

  private created(by: string, state: RegisterState, fields: Verdict<TaskFields>): Verdict<RegisterEvent> {
    if (!fields.ok) {
      return fields;
    }
    const event: CreateEvent = { ...this.base(state.nextId, by), type: 'create', task: fields.value };
    return { ok: true, value: event };
  }

  private base(id: string, by: string): { v: number; id: string; at: string; by: string } {
    return { v: EVENT_VERSION, id, at: new Date(this.deps.clock.now()).toISOString(), by };
  }

  /** A write by a session of this team: refused unless the caller is on the roster. */
  private async commit(caller: string, decide: (state: RegisterState) => Verdict<RegisterEvent>): Promise<Verdict<WriteResult>> {
    const callerProblem = this.deps.policy.checkCaller(caller);
    if (callerProblem !== undefined) {
      return { ok: false, error: callerProblem };
    }
    return this.write(decide);
  }

  /** Under the lock: refuse newer data, replay, decide on one event, append it, return the task after it. */
  private write(decide: (state: RegisterState) => Verdict<RegisterEvent>): Promise<Verdict<WriteResult>> {
    return this.deps.mutex.run(async () => {
      const read = await this.deps.log.read();
      if (!isWritable(read)) {
        throw new NewerDataError(this.deps.log.path, read.newestVersion, EVENT_VERSION);
      }
      const decision = decide(foldEvents(read.events, read.seenIds));
      if (!decision.ok) {
        return decision;
      }
      const event = decision.value;
      await this.deps.log.append(event);
      const task = foldEvents([...read.events, event], read.seenIds).tasks.get(event.id);
      if (task === undefined) {
        throw new Error(`${event.id} is missing after its own write`);
      }
      return { ok: true, value: { task, event } };
    });
  }
}

function onTask(state: RegisterState, id: string, decide: (task: Task) => Verdict<RegisterEvent>): Verdict<RegisterEvent> {
  const task = state.tasks.get(id);
  return task === undefined ? { ok: false, error: `no task ${id}` } : decide(task);
}
