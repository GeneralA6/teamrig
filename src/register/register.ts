import { errorMessage } from '../core/guards.ts';
import { NewerDataError } from '../core/jsonl.ts';
import type { Clock, Mutex } from '../core/lock.ts';
import type { TimeZone } from '../core/zone.ts';
import { EVENT_VERSION, type ApprovalVerdict, type CreateEvent, type RegisterEvent, type StatusEvent, type TaskFields, type UpdateEvent } from './events.ts';
import { foldEvents, taskNumber, type RegisterState, type Task } from './fold.ts';
import { GITHUB_ACTOR, NO_SKILL, type AddInput, type AskInput, type ImportChanges, type ImportInput, type RegisterPolicy, type StatusContext, type StatusInput, type Verdict } from './policy.ts';
import { ACTIVE_STATUSES } from './model.ts';
import type { TaskNumbering } from './numbering.ts';
import { isWritable, type RegisterSnapshot } from './snapshot.ts';
import type { EventLog } from './store.ts';
import { NO_TASKS_ELSEWHERE, type TasksElsewhere } from './tree.ts';
import type { WaitReason } from './waits.ts';

/** Tells whether a skill exists, so `done --skill <name>` cannot cite one that was never written. */
export interface SkillCatalog {
  exists(name: string): Promise<boolean>;
}

/**
 * Reads the tasks the team tree's other registers hold: a write judges a wait, an `--after` or a follow-up that
 * names one of them against it, and refuses to change one, as only its own team's sessions do.
 */
export interface ElsewhereReader {
  read(): Promise<TasksElsewhere>;
}

/** The reader of a register no other register shares a tree with: nothing is held elsewhere. */
export const NOTHING_ELSEWHERE: ElsewhereReader = { read: () => Promise.resolve(NO_TASKS_ELSEWHERE) };

export interface RegisterDeps {
  readonly log: EventLog;
  readonly mutex: Mutex;
  /** Where a new task's number comes from: the register alone, or every register of the team's tree. */
  readonly numbering: TaskNumbering;
  /** The tasks of the team tree's other registers, read at each write before its lock (T1139). */
  readonly elsewhere: ElsewhereReader;
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
  /** The tasks the team tree's other registers held when the write was judged, for a reader to judge the task with. */
  readonly elsewhere: TasksElsewhere;
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

  /** The tasks the team tree's other registers hold, which a read judges a wait on one of them against (T1139). */
  elsewhere(): Promise<TasksElsewhere> {
    return this.deps.elsewhere.read();
  }

  add(caller: string, input: AddInput): Promise<Verdict<WriteResult>> {
    return this.asCaller(caller, () => this.writeNew(({ state }, id, elsewhere) => single(this.created(caller, id, this.deps.policy.add(input, state, elsewhere)))));
  }

  /**
   * A task from the parent team's lead, `parentLead` being its `<team>/<id>`. The tree's rules decide
   * who that may be, so this team's roster check is skipped; the event names that lead as its writer.
   */
  addFromParent(parentLead: string, input: AddInput): Promise<Verdict<WriteResult>> {
    return this.writeNew(({ state }, id, elsewhere) => single(this.created(parentLead, id, this.deps.policy.addFromParent(input, state, elsewhere))));
  }

  /**
   * The GitHub import's writes (github/sync.ts): each is judged again under the lock, on the register as it
   * then stands, and written by GITHUB_ACTOR, which is on no roster. The policy limits them to the import's
   * own tasks: a new one per issue, its title and priority, and open, done or dropped as GitHub has it.
   */
  importAdd(input: ImportInput): Promise<Verdict<WriteResult>> {
    return this.writeNew(({ state }, id) => single(this.created(GITHUB_ACTOR, id, this.deps.policy.importAdd(input, state))));
  }

  importUpdate(id: string, changes: ImportChanges, note: string): Promise<Verdict<WriteResult>> {
    return this.write((snapshot, elsewhere) =>
      onTask(snapshot, elsewhere, id, (task) => {
        const change = this.deps.policy.importUpdate(task, changes, note);
        return single(change.ok ? { ok: true, value: { ...this.base(id, GITHUB_ACTOR), type: 'update', ...change.value } } : change);
      }),
    );
  }

  importStatus(id: string, input: StatusInput): Promise<Verdict<WriteResult>> {
    return this.write((snapshot, elsewhere) =>
      onTask(snapshot, elsewhere, id, (task) => {
        const change = this.deps.policy.importStatus(task, input);
        return single(change.ok ? { ok: true, value: { ...this.base(id, GITHUB_ACTOR), type: 'status', ...change.value } } : change);
      }),
    );
  }

  async setStatus(caller: string, id: string, input: StatusInput): Promise<Verdict<WriteResult>> {
    const skillExists = await this.skillExists(input);
    return this.commit(caller, (snapshot, elsewhere) =>
      onTask(snapshot, elsewhere, id, (task) =>
        this.statusEvents(task, caller, input, { state: snapshot.state, elsewhere, now: new Date(this.deps.clock.now()), zone: this.deps.zone, skillExists }),
      ),
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
    const written = await this.asCaller(caller, () =>
      this.writeNew((snapshot, askedId, elsewhere) =>
        onTask(snapshot, elsewhere, id, (task) => {
          const fields = this.deps.policy.ask(task, caller, ask, input, snapshot.state);
          if (!fields.ok) {
            return fields;
          }
          const created: CreateEvent = { ...this.base(askedId, caller), type: 'create', task: fields.value };
          const state = foldEvents([created], [], snapshot.state);
          const waits: readonly WaitReason[] = [...(input.waits ?? []), { kind: 'task', id: askedId }];
          const asking: StatusInput = { ...input, waits, note: input.note ?? fields.value.title };
          const status = this.statusEvents(task, caller, asking, { state, elsewhere, now: new Date(this.deps.clock.now()), zone: this.deps.zone, skillExists });
          return status.ok ? { ok: true, value: [created, ...status.value] } : status;
        }),
      ),
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
    return this.commit(caller, (snapshot, elsewhere) =>
      onTask(snapshot, elsewhere, id, (task) => {
        const change = this.deps.policy.update(task, caller, changes, note, snapshot.state, elsewhere);
        if (!change.ok) {
          return change;
        }
        const event: UpdateEvent = { ...this.base(id, caller), type: 'update', ...change.value };
        const { pin, owner } = change.value.changes;
        const unpins = typeof pin === 'string' ? this.unpins(task, owner ?? task.owner, caller, snapshot.state) : [];
        return { ok: true, value: [...unpins, event] };
      }),
    );
  }

  /**
   * One pin per owner: the unpins of the other active pinned tasks of `owner`, the owner of `pinned` once pinned,
   * written before the pin so that stays the write's last event. The policy let `caller` pin a task of `owner`, which
   * is leave to move that owner's pin (T637).
   */
  private unpins(pinned: Task, owner: string, caller: string, state: RegisterState): UpdateEvent[] {
    return [...state.tasks.values()]
      .filter((task) => task.id !== pinned.id && task.owner === owner && task.pin !== null && ACTIVE_STATUSES.includes(task.status))
      .map((task): UpdateEvent => ({ ...this.base(task.id, caller), type: 'update', changes: { pin: null }, note: `the pin moved to ${pinned.id}` }));
  }

  /** `approve`: the lead's answer to a task's approval wait, an update that changes no field (T684). */
  approve(caller: string, id: string, verdict: ApprovalVerdict, note: string | undefined): Promise<Verdict<WriteResult>> {
    return this.commit(caller, (snapshot, elsewhere) =>
      onTask(snapshot, elsewhere, id, (task) => {
        const change = this.deps.policy.approve(task, caller, verdict, note);
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
  private commit(caller: string, decide: (snapshot: RegisterSnapshot, elsewhere: TasksElsewhere) => Verdict<readonly RegisterEvent[]>): Promise<Verdict<WriteResult>> {
    return this.asCaller(caller, () => this.write(decide));
  }

  /** Runs `write` for a session of this team: refused unless the caller is on the roster. */
  private async asCaller<T>(caller: string, write: () => Promise<Verdict<T>>): Promise<Verdict<T>> {
    const callerProblem = this.deps.policy.checkCaller(caller);
    if (callerProblem !== undefined) {
      return { ok: false, error: callerProblem };
    }
    return write();
  }

  /**
   * A write that creates a task, under the numbering: the new id is the higher of the register's own next one and
   * the numbering's floor, so it is free in every register that shares the numbering (numbering.ts).
   */
  private writeNew(decide: (snapshot: RegisterSnapshot, id: string, elsewhere: TasksElsewhere) => Verdict<readonly RegisterEvent[]>): Promise<Verdict<WriteResult>> {
    return this.deps.numbering.issue((floor) =>
      this.write((snapshot, elsewhere) => decide(snapshot, `T${Math.max(taskNumber(snapshot.state.nextId), floor)}`, elsewhere)),
    );
  }

  /**
   * Read the tasks the team tree's other registers hold, which their own locks guard, so before this register's;
   * then under the lock: refuse newer data, read the working set, decide on the events (one; a due date and a
   * status; or an asked task and the status that waits on it), append them, rotate the log when it is due and the
   * team has not turned that off, and return the task after the events.
   */
  private async write(decide: (snapshot: RegisterSnapshot, elsewhere: TasksElsewhere) => Verdict<readonly RegisterEvent[]>): Promise<Verdict<WriteResult>> {
    const elsewhere = await this.deps.elsewhere.read();
    return this.deps.mutex.run(async () => {
      const snapshot = await this.deps.log.read();
      if (!isWritable(snapshot.read)) {
        throw new NewerDataError(this.deps.log.path, snapshot.read.newestVersion, EVENT_VERSION);
      }
      const decision = decide(snapshot, elsewhere);
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
      return { ok: true, value: { task, before, state, elsewhere, event, events, rotation: await this.rotation(snapshot) } };
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

/** One event, as the list a write takes. */
function single(verdict: Verdict<RegisterEvent>): Verdict<readonly RegisterEvent[]> {
  return verdict.ok ? { ok: true, value: [verdict.value] } : verdict;
}

/**
 * The decision on a task of the working set. An id another register of the team tree holds is that team's task,
 * which only its own sessions change. An id below the next one that is in neither may be a task a compaction
 * retired: it is named as such, as this teamrig changes only tasks in the working set.
 */
function onTask<T>(snapshot: RegisterSnapshot, elsewhere: TasksElsewhere, id: string, decide: (task: Task) => Verdict<T>): Verdict<T> {
  const task = snapshot.state.tasks.get(id);
  if (task !== undefined) {
    return decide(task);
  }
  const away = elsewhere.get(id);
  if (away !== undefined) {
    return { ok: false, error: `${id} is team ${away.team}'s task (owner ${away.task.owner}): only a session of team ${away.team} changes it` };
  }
  const archived = snapshot.retired !== null && taskNumber(id) < taskNumber(snapshot.state.nextId);
  return { ok: false, error: archived ? `no task ${id} in the working set: if it was finished long ago it is archived (teamrig show ${id})` : `no task ${id}` };
}
