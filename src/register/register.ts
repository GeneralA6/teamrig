import { errorMessage } from '../core/guards.ts';
import { NewerDataError } from '../core/jsonl.ts';
import type { Clock, Mutex } from '../core/lock.ts';
import type { TimeZone } from '../core/zone.ts';
import { EVENT_VERSION, type CreateEvent, type RegisterEvent, type StatusEvent, type TaskFields, type UpdateEvent } from './events.ts';
import { foldEvents, taskNumber, type RegisterState, type Task } from './fold.ts';
import { GITHUB_ACTOR, NO_SKILL, type AddInput, type AskInput, type ImportChanges, type ImportInput, type RegisterPolicy, type StatusContext, type StatusInput, type Verdict } from './policy.ts';
import { isWritable, type RegisterSnapshot } from './snapshot.ts';
import type { EventLog } from './store.ts';
import type { WaitReason } from './waits.ts';

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
  /** The team's zone: a stored day (a due, a time to wait until, a week tag) is a day of it. */
  readonly zone: TimeZone;
  /**
   * The team's `register.autoArchive`: false, and a write never rotates the log, however long its tail
   * grows; `teamrig compact` still rotates it by hand.
   */
  readonly autoArchive: boolean;
}

/** What became of the rotation a write runs after its append when the log is due (store.ts). */
export type RotationOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'rotated'; readonly segment: number; readonly retired: number }
  /** The write is saved and every file still reads whole; the next write tries again. */
  | { readonly kind: 'failed'; readonly error: string };

export interface WriteResult {
  readonly task: Task;
  /** The task before the write, null for a new one: what the write changed, such as who owns it. */
  readonly before: Task | null;
  /** The register after the write, so a reader judges the task against the others (a waiting task's reasons). */
  readonly state: RegisterState;
  /** The last event written: the status event of a `set` that also moved the due date or asked for a task before it. */
  readonly event: RegisterEvent;
  /** Every event written, oldest first, ending with {@link event}. */
  readonly events: readonly RegisterEvent[];
  readonly rotation: RotationOutcome;
}

/** A `set --ask`: the caller's task, now waiting, and the task the ask created. */
export interface AskResult extends WriteResult {
  /** The task the ask created, owned by the session asked. */
  readonly asked: Task;
}

/**
 * The register's write path: under the lock, read the log, replay it, apply the team policy,
 * append its events and return the task as it now stands. Reads take no lock.
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
    return this.commit(caller, ({ state }) => single(this.created(caller, state.nextId, this.deps.policy.add(input, state))));
  }

  /**
   * A task from the parent team's lead, `parentLead` being its `<team>/<id>`. The tree's rules decide
   * who that may be, so this team's roster check is skipped; the event names that lead as its writer.
   */
  addFromParent(parentLead: string, input: AddInput): Promise<Verdict<WriteResult>> {
    return this.write(({ state }) => single(this.created(parentLead, state.nextId, this.deps.policy.addFromParent(input, state))));
  }

  /**
   * The GitHub import's writes (github/sync.ts): each is judged again under the lock, on the register as it
   * then stands, and written by GITHUB_ACTOR, which is on no roster. The policy limits them to the import's
   * own tasks: a new one per issue, its title and priority, and open, done or dropped as GitHub has it.
   */
  importAdd(input: ImportInput): Promise<Verdict<WriteResult>> {
    return this.write(({ state }) => single(this.created(GITHUB_ACTOR, state.nextId, this.deps.policy.importAdd(input, state))));
  }

  importUpdate(id: string, changes: ImportChanges, note: string): Promise<Verdict<WriteResult>> {
    return this.write((snapshot) =>
      onTask(snapshot, id, (task) => {
        const change = this.deps.policy.importUpdate(task, changes, note);
        return single(change.ok ? { ok: true, value: { ...this.base(id, GITHUB_ACTOR), type: 'update', ...change.value } } : change);
      }),
    );
  }

  importStatus(id: string, input: StatusInput): Promise<Verdict<WriteResult>> {
    return this.write((snapshot) =>
      onTask(snapshot, id, (task) => {
        const change = this.deps.policy.importStatus(task, input);
        return single(change.ok ? { ok: true, value: { ...this.base(id, GITHUB_ACTOR), type: 'status', ...change.value } } : change);
      }),
    );
  }

  async setStatus(caller: string, id: string, input: StatusInput): Promise<Verdict<WriteResult>> {
    const skillExists = await this.skillExists(input);
    return this.commit(caller, (snapshot) =>
      onTask(snapshot, id, (task) => this.statusEvents(task, caller, input, { state: snapshot.state, now: new Date(this.deps.clock.now()), zone: this.deps.zone, skillExists })),
    );
  }

  /**
   * `set <id> --status waiting|verifying --ask <session> --text "<the work>"`, in one write: the task asked of that
   * session, then the caller's task set waiting on it, or its proof (after any `--waits` reasons given), so neither
   * lands without the other. The status is judged on the register with the asked task in it; with no `--note`, the
   * work asked for is the note.
   */
  async ask(caller: string, id: string, ask: AskInput, input: StatusInput): Promise<Verdict<AskResult>> {
    const skillExists = await this.skillExists(input);
    const written = await this.commit(caller, (snapshot) =>
      onTask(snapshot, id, (task) => {
        const fields = this.deps.policy.ask(task, caller, ask, input, snapshot.state);
        if (!fields.ok) {
          return fields;
        }
        const askedId = snapshot.state.nextId;
        const created: CreateEvent = { ...this.base(askedId, caller), type: 'create', task: fields.value };
        const state = foldEvents([created], [], snapshot.state);
        const waits: readonly WaitReason[] = [...(input.waits ?? []), { kind: 'task', id: askedId }];
        const asking: StatusInput = { ...input, waits, note: input.note ?? fields.value.title };
        const status = this.statusEvents(task, caller, asking, { state, now: new Date(this.deps.clock.now()), zone: this.deps.zone, skillExists });
        return status.ok ? { ok: true, value: [created, ...status.value] } : status;
      }),
    );
    if (!written.ok) {
      return written;
    }
    const [created] = written.value.events;
    const asked = created === undefined ? undefined : written.value.state.tasks.get(created.id);
    if (asked === undefined) {
      throw new Error(`the ask for ${id} wrote no task`);
    }
    return { ok: true, value: { ...written.value, asked } };
  }

  update(caller: string, id: string, changes: Partial<TaskFields>, note: string | undefined): Promise<Verdict<WriteResult>> {
    return this.commit(caller, (snapshot) =>
      onTask(snapshot, id, (task) => {
        const change = this.deps.policy.update(task, caller, changes, note, snapshot.state);
        if (!change.ok) {
          return change;
        }
        const event: UpdateEvent = { ...this.base(id, caller), type: 'update', ...change.value };
        return { ok: true, value: [event] };
      }),
    );
  }

  /** Whether the skill a status change cites exists; true when it cites none. */
  private async skillExists(input: StatusInput): Promise<boolean> {
    const skill = input.skill?.trim();
    return skill === undefined || skill === '' || skill === NO_SKILL || (await this.deps.skills.exists(skill));
  }

  /** A status change as events: the status, after an update that moves the due date when the change sets one. */
  private statusEvents(task: Task, caller: string, input: StatusInput, context: StatusContext): Verdict<readonly RegisterEvent[]> {
    const change = this.deps.policy.setStatus(task, caller, input, context);
    if (!change.ok) {
      return change;
    }
    const { due, ...status } = change.value;
    const event: StatusEvent = { ...this.base(task.id, caller), type: 'status', ...status };
    if (due === undefined) {
      return { ok: true, value: [event] };
    }
    const dated: UpdateEvent = { ...this.base(task.id, caller), type: 'update', changes: { due }, note: null };
    return { ok: true, value: [dated, event] };
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
  private async commit(caller: string, decide: (snapshot: RegisterSnapshot) => Verdict<readonly RegisterEvent[]>): Promise<Verdict<WriteResult>> {
    const callerProblem = this.deps.policy.checkCaller(caller);
    if (callerProblem !== undefined) {
      return { ok: false, error: callerProblem };
    }
    return this.write(decide);
  }

  /**
   * Under the lock: refuse newer data, read the working set, decide on the events (one; a due date and a status;
   * or an asked task and the status that waits on it), append them, rotate the log when it is due and the team has not turned that
   * off, and return the task after the events.
   */
  private write(decide: (snapshot: RegisterSnapshot) => Verdict<readonly RegisterEvent[]>): Promise<Verdict<WriteResult>> {
    return this.deps.mutex.run(async () => {
      const snapshot = await this.deps.log.read();
      if (!isWritable(snapshot.read)) {
        throw new NewerDataError(this.deps.log.path, snapshot.read.newestVersion, EVENT_VERSION);
      }
      const decision = decide(snapshot);
      if (!decision.ok) {
        return decision;
      }
      const events = decision.value;
      const event = events.at(-1);
      if (event === undefined) {
        throw new Error('a write decided on no event');
      }
      await this.deps.log.append(events);
      const state = foldEvents(events, [], snapshot.state);
      const task = state.tasks.get(event.id);
      if (task === undefined) {
        throw new Error(`${event.id} is missing after its own write`);
      }
      const before = snapshot.state.tasks.get(event.id) ?? null;
      return { ok: true, value: { task, before, state, event, events, rotation: await this.rotation(snapshot) } };
    });
  }

  /**
   * None when the team turned automatic archiving off. A rotation that fails leaves the write saved and the
   * files readable (rotate.ts): it is reported, never thrown.
   */
  private async rotation(written: RegisterSnapshot): Promise<RotationOutcome> {
    if (!this.deps.autoArchive) {
      return { kind: 'none' };
    }
    try {
      const plan = await this.deps.log.rotateIfDue(written, new Date(this.deps.clock.now()), this.deps.zone);
      return plan === null ? { kind: 'none' } : { kind: 'rotated', segment: plan.segment, retired: plan.compaction.retiredNow.length };
    } catch (error) {
      return { kind: 'failed', error: errorMessage(error) };
    }
  }
}

/**
 * The decision on a task of the working set. An id below the next one that is not in it may be a task a
 * compaction retired: it is named as such, as this teamrig changes only tasks in the working set.
 */
/** One event, as the list a write takes. */
function single(verdict: Verdict<RegisterEvent>): Verdict<readonly RegisterEvent[]> {
  return verdict.ok ? { ok: true, value: [verdict.value] } : verdict;
}

function onTask<T>(snapshot: RegisterSnapshot, id: string, decide: (task: Task) => Verdict<T>): Verdict<T> {
  const task = snapshot.state.tasks.get(id);
  if (task !== undefined) {
    return decide(task);
  }
  const archived = snapshot.retired !== null && taskNumber(id) < taskNumber(snapshot.state.nextId);
  return { ok: false, error: archived ? `no task ${id} in the working set: if it was finished long ago it is archived (teamrig show ${id})` : `no task ${id}` };
}
