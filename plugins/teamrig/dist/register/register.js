import { errorMessage } from "../core/guards.js";
import { NewerDataError } from "../core/jsonl.js";
import { EVENT_VERSION, TASK_LINE_VERSION } from "./events.js";
import { foldEvents, taskNumber } from "./fold.js";
import { NO_GOAL_TAGS } from "./goals.js";
import { GITHUB_ACTOR, NO_SKILL } from "./policy.js";
import { ACTIVE_STATUSES } from "./model.js";
import { isWritable } from "./snapshot.js";
import { needsElsewhere, NO_TASKS_ELSEWHERE } from "./tree.js";
/** The reader of a register no other register shares a tree with: nothing is held elsewhere. */
export const NOTHING_ELSEWHERE = { read: () => Promise.resolve(NO_TASKS_ELSEWHERE) };
/** The reader of a team that keeps no goal records, as under `register.goals` free: no tag is read. */
export const NO_GOAL_RECORDS = { read: () => Promise.resolve(NO_GOAL_TAGS) };
/**
 * The register's write path: under the lock, read the log, replay it, apply the team policy,
 * append its events and return the task as it now stands. Reads take no lock.
 */
export class Register {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /** The working set, read without the lock, as every read is. */
    snapshot() {
        return this.deps.log.read();
    }
    /** Every task ever written, for a reader the working set cannot serve (layout.ts). */
    history() {
        return this.deps.log.readHistory();
    }
    /** The tasks the team tree's other registers hold, which a read judges a wait on one of them against (T1139). */
    elsewhere() {
        return this.deps.elsewhere.read();
    }
    /**
     * The working set, and the tasks the team tree's other registers hold only when an active task needs an id it lacks
     * ({@link needsElsewhere}), so a read that runs often, such as the wake check, reads one log for a team whose tasks
     * all need tasks of its own.
     */
    async snapshotWithElsewhere() {
        const snapshot = await this.snapshot();
        return { snapshot, elsewhere: needsElsewhere(snapshot.state.tasks) ? await this.elsewhere() : NO_TASKS_ELSEWHERE };
    }
    add(caller, input) {
        return this.asCaller(caller, async () => {
            const goalTags = await this.goalTagsFor(input.goals);
            return this.writeNew(({ state }, id, elsewhere) => single(this.created(caller, id, this.deps.policy.add(input, state, elsewhere, goalTags))));
        });
    }
    /**
     * A task asked by a session of another team, `asker` being its `<team>/<id>`. The tree's rules decide who
     * may ask, so this team's roster check is skipped; the event names the asker as its writer.
     */
    async addFromTeam(asker, input) {
        const goalTags = await this.goalTagsFor(input.goals);
        return this.writeNew(({ state }, id, elsewhere) => single(this.created(asker, id, this.deps.policy.addFromTeam(input, state, elsewhere, goalTags))));
    }
    /**
     * A note on a task from the lead who asks the owner this team's decisions, `asker` being its `<team>/<id>`
     * (TeamTree.ownerLeadAbove, T1018), such as the owner's answer. The tree's rules decide who that may be, so this
     * team's roster check is skipped; a note changes nothing on the task, so it is all this write may add.
     */
    noteFrom(asker, id, note) {
        return this.write((snapshot, elsewhere) => onTask(snapshot, elsewhere, id, (task) => {
            const change = this.deps.policy.update(task, asker, {}, note, snapshot.state, elsewhere);
            return single(change.ok ? { ok: true, value: { ...this.base(id, asker), type: 'update', ...change.value } } : change);
        }));
    }
    /**
     * The GitHub import's writes (github/sync.ts): each is judged again under the lock, on the register as it
     * then stands, and written by GITHUB_ACTOR, which is on no roster. The policy limits them to the import's
     * own tasks: a new one per issue, its title and priority, and open, done or dropped as GitHub has it.
     */
    importAdd(input) {
        return this.writeNew(({ state }, id) => single(this.created(GITHUB_ACTOR, id, this.deps.policy.importAdd(input, state))));
    }
    importUpdate(id, changes, note) {
        return this.write((snapshot, elsewhere) => onTask(snapshot, elsewhere, id, (task) => {
            const change = this.deps.policy.importUpdate(task, changes, note);
            return single(change.ok ? { ok: true, value: { ...this.base(id, GITHUB_ACTOR), type: 'update', ...change.value } } : change);
        }));
    }
    importStatus(id, input) {
        return this.write((snapshot, elsewhere) => onTask(snapshot, elsewhere, id, (task) => {
            const change = this.deps.policy.importStatus(task, input);
            return single(change.ok ? { ok: true, value: { ...this.base(id, GITHUB_ACTOR), type: 'status', ...change.value } } : change);
        }));
    }
    async setStatus(caller, id, input) {
        const skillExists = await this.skillExists(input);
        return this.commit(caller, (snapshot, elsewhere) => onTask(snapshot, elsewhere, id, (task) => this.statusEvents(task, caller, input, { state: snapshot.state, elsewhere, now: new Date(this.deps.clock.now()), zone: this.deps.zone, skillExists })));
    }
    /**
     * `set <id> --status waiting --ask <session> --text "<the work>"`, in one write: the task asked of that session,
     * then the caller's task set waiting on it (after any `--waits` reasons given), so neither lands without the
     * other. The status is judged on the register with the asked task in it; with no `--note`, the
     * work asked for is the note.
     */
    async ask(caller, id, ask, input) {
        const skillExists = await this.skillExists(input);
        const written = await this.asCaller(caller, () => this.writeNew((snapshot, askedId, elsewhere) => onTask(snapshot, elsewhere, id, (task) => {
            const fields = this.deps.policy.ask(task, caller, ask, input, snapshot.state);
            if (!fields.ok) {
                return fields;
            }
            const created = { ...this.base(askedId, caller), type: 'create', task: fields.value };
            const state = foldEvents([created], [], snapshot.state);
            const waits = [...(input.waits ?? []), { kind: 'task', id: askedId }];
            const asking = { ...input, waits, note: input.note ?? fields.value.title };
            const status = this.statusEvents(task, caller, asking, { state, elsewhere, now: new Date(this.deps.clock.now()), zone: this.deps.zone, skillExists });
            return status.ok ? { ok: true, value: [created, ...status.value] } : status;
        })));
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
    /**
     * `update <id>`: the changes the policy lets the caller make. `sizeBase` is what the task had cost today when the
     * caller read it (T649): the event carries it only when it gives the task a size, so OVER-SIZE counts what it spends
     * after that size was set.
     */
    update(caller, id, changes, note, sizeBase) {
        return this.asCaller(caller, async () => {
            const goalTags = await this.goalTagsFor(changes.goals);
            return this.write((snapshot, elsewhere) => onTask(snapshot, elsewhere, id, (task) => {
                const change = this.deps.policy.update(task, caller, changes, note, snapshot.state, elsewhere, goalTags);
                if (!change.ok) {
                    return change;
                }
                const event = this.updateEvent(id, caller, change.value, sizeBase);
                const { pin, owner } = change.value.changes;
                const unpins = typeof pin === 'string' ? this.unpins(task, owner ?? task.owner, caller, snapshot.state) : [];
                return { ok: true, value: [...unpins, event] };
            }));
        });
    }
    /** A confirmed sweep row, by the task's owner or a leader over it on this team (T2086). */
    triage(caller, id, changes, sizeBase) {
        return this.asCaller(caller, () => this.triageWrite(caller, id, changes, sizeBase, (task, state, elsewhere, goalTags) => this.deps.policy.triage(task, caller, changes, state, elsewhere, goalTags)));
    }
    /**
     * A confirmed sweep row by the lead of a team above, `asker` being its `<team>/<id>`. The tree's rules decide who that
     * may be, so this team's roster check is skipped, as in noteFrom.
     */
    triageFrom(asker, id, changes, sizeBase) {
        return this.triageWrite(asker, id, changes, sizeBase, (task, state, elsewhere, goalTags) => this.deps.policy.triageFrom(task, changes, state, elsewhere, goalTags));
    }
    async triageWrite(by, id, changes, sizeBase, judge) {
        const goalTags = await this.goalTagsFor(changes.goals);
        return this.write((snapshot, elsewhere) => onTask(snapshot, elsewhere, id, (task) => {
            const change = judge(task, snapshot.state, elsewhere, goalTags);
            return single(change.ok ? { ok: true, value: this.updateEvent(id, by, change.value, sizeBase) } : change);
        }));
    }
    /** The event of an allowed update; `sizeBase` rides on it only when the update gives the task a size. */
    updateEvent(id, by, change, sizeBase) {
        const sized = typeof change.changes.size === 'number' && sizeBase !== undefined;
        return { ...this.base(id, by), type: 'update', ...change, ...(sized ? { sizeBase } : {}) };
    }
    /** The goal tags `goals` is held to: read only when a write names some, so most writes read no goal records. */
    async goalTagsFor(goals) {
        return goals === undefined || goals.length === 0 ? NO_GOAL_TAGS : this.deps.goals.read();
    }
    /**
     * One pin per owner: the unpins of the other active pinned tasks of `owner`, the owner of `pinned` once pinned,
     * written before the pin so that stays the write's last event. The policy let `caller` pin a task of `owner`, which
     * is leave to move that owner's pin (T637).
     */
    unpins(pinned, owner, caller, state) {
        return otherPins(pinned, owner, state).map((task) => ({ ...this.base(task.id, caller), type: 'update', changes: { pin: null }, note: `the pin moved to ${pinned.id}` }));
    }
    /**
     * The owner's Note from the pane (T1298), written as the team's register.ownerSource, on no roster: the CLI writes it
     * only for the owner (a hook refuses it from an agent's tool call), so the roster check is skipped, as in noteFrom.
     */
    ownerNote(id, note) {
        return this.write((snapshot, elsewhere) => onTask(snapshot, elsewhere, id, (task) => single(this.ownerEvent(task, this.deps.policy.ownerNote(task, note)))));
    }
    /** The owner's Next from the pane (T1298): the owner's pin after the unpins it moves down, in one append, written as in ownerNote. */
    ownerNext(id) {
        return this.write((snapshot, elsewhere) => onTask(snapshot, elsewhere, id, (task) => {
            const event = this.ownerEvent(task, this.deps.policy.ownerNext(task));
            return event.ok ? { ok: true, value: [...this.unpins(task, task.owner, event.value.by, snapshot.state), event.value] } : event;
        }));
    }
    /** What ownerNext would do now, judged alike on a read without the lock, writing nothing: for the pane's confirm step. */
    async ownerNextPreview(id) {
        const snapshot = await this.snapshot();
        return onTask(snapshot, await this.elsewhere(), id, (task) => {
            const change = this.deps.policy.ownerNext(task);
            return change.ok ? { ok: true, value: { task, moves: otherPins(task, task.owner, snapshot.state) } } : change;
        });
    }
    ownerEvent(task, change) {
        if (!change.ok) {
            return change;
        }
        const { by, ...update } = change.value;
        return { ok: true, value: { ...this.base(task.id, by), type: 'update', ...update } };
    }
    /** `approve`: the lead's answer to a task's approval wait, an update that changes no field (T684). */
    approve(caller, id, verdict, note) {
        return this.commit(caller, (snapshot, elsewhere) => onTask(snapshot, elsewhere, id, (task) => {
            const change = this.deps.policy.approve(task, caller, verdict, note);
            if (!change.ok) {
                return change;
            }
            const event = { ...this.base(id, caller), type: 'update', ...change.value };
            return { ok: true, value: [event] };
        }));
    }
    /**
     * `approve <team>/<id>`: the parent team's answer to an approval wait of this team's lead (T1140), written as its
     * lead's `<team>/<id>`. The tree decides who that may be, so this team's roster check is skipped, as in noteFrom; the
     * policy still holds the answer to the task owner's approvers.
     */
    approveFrom(asker, id, verdict, note) {
        return this.write((snapshot, elsewhere) => onTask(snapshot, elsewhere, id, (task) => {
            const change = this.deps.policy.approve(task, asker, verdict, note);
            return single(change.ok ? { ok: true, value: { ...this.base(id, asker), type: 'update', ...change.value } } : change);
        }));
    }
    /**
     * `update <id> --later <when|none>`: the owner puts a card off to time `until` (stored form), or `null` brings it back
     * (T1295), an update that changes no field and gives the task its waits from then on.
     */
    defer(caller, id, until, note) {
        return this.commit(caller, (snapshot, elsewhere) => onTask(snapshot, elsewhere, id, (task) => single(this.noFieldEvent(task, caller, this.deps.policy.defer(task, caller, until, note, this.timeContext())))));
    }
    /**
     * A Later from the lead above who asks the owner this team's decisions, `asker` being its `<team>/<id>`, as in
     * noteFrom: the tree decides who that may be, so this team's roster check and the policy's caller check are skipped.
     */
    deferFrom(asker, id, until, note) {
        return this.write((snapshot, elsewhere) => onTask(snapshot, elsewhere, id, (task) => single(this.noFieldEvent(task, asker, this.deps.policy.deferFrom(task, until, note, this.timeContext())))));
    }
    /**
     * `update <id> --decided`: the owner's answer to a card (T1366), an update that changes no field, drops the task's
     * wait on the owner and marks it decided for its session to act on.
     */
    decide(caller, id, note) {
        return this.commit(caller, (snapshot, elsewhere) => onTask(snapshot, elsewhere, id, (task) => single(this.noFieldEvent(task, caller, this.deps.policy.decide(task, caller, note)))));
    }
    /** A Decided from the lead above who asks the owner this team's decisions, `asker` being its `<team>/<id>`, as in deferFrom. */
    decideFrom(asker, id, note) {
        return this.write((snapshot, elsewhere) => onTask(snapshot, elsewhere, id, (task) => single(this.noFieldEvent(task, asker, this.deps.policy.decideFrom(task, note)))));
    }
    /**
     * `audit <id> --file <path>`: a session of this team pins a hand step file for the task at its sha256 (T2312), an
     * update that changes no field, so the task's card may hand the file to the owner.
     */
    audit(caller, id, pin, note) {
        return this.commit(caller, (snapshot, elsewhere) => onTask(snapshot, elsewhere, id, (task) => single(this.noFieldEvent(task, caller, this.deps.policy.audit(task, caller, pin, note)))));
    }
    /**
     * `audit <id> --file <path> --team <child>`: an audit from a team above, `asker` being its `<team>/<id>`, as in
     * approveFrom: the tree decides who that may be, so this team's roster check is skipped; the policy still holds the
     * audit to the task owner's auditors.
     */
    auditFrom(asker, id, pin, note) {
        return this.write((snapshot, elsewhere) => onTask(snapshot, elsewhere, id, (task) => single(this.noFieldEvent(task, asker, this.deps.policy.auditFrom(task, asker, pin, note)))));
    }
    /** The update a Later, a Decided or an audit writes: no field changed; the task's waits from then on, or the file pinned. */
    noFieldEvent(task, by, change) {
        return change.ok ? { ok: true, value: { ...this.base(task.id, by), type: 'update', ...change.value } } : change;
    }
    /** The clock and zone a write judges a time against. */
    timeContext() {
        return { now: new Date(this.deps.clock.now()), zone: this.deps.zone };
    }
    /**
     * A team split's write (T1144), by a session of this team: under the lock, `move` decides on the working set, writes
     * what goes to the other team and returns the events this register keeps of it, appended as one write; a refusal
     * appends nothing. Returns the state after them. The log rotates at the next write, as a split is a lead's one-off.
     */
    moveOut(caller, move) {
        return this.asCaller(caller, () => this.deps.mutex.run(async () => {
            const snapshot = await this.writableSnapshot();
            const moved = await move(snapshot);
            if (!moved.ok) {
                return moved;
            }
            if (moved.value.length > 0) {
                await this.deps.log.append(moved.value);
            }
            return { ok: true, value: foldEvents(moved.value, [], snapshot.state) };
        }));
    }
    /** Whether the skill a status change cites exists; true when it cites none. */
    async skillExists(input) {
        const skill = input.skill?.trim();
        return skill === undefined || skill === '' || skill === NO_SKILL || (await this.deps.skills.exists(skill));
    }
    /** A status change as events: the status, after an update that moves the due date when the change sets one. */
    statusEvents(task, caller, input, context) {
        const change = this.deps.policy.setStatus(task, caller, input, context);
        if (!change.ok) {
            return change;
        }
        const { due, ...status } = change.value;
        const event = { ...this.base(task.id, caller), type: 'status', ...status };
        if (due === undefined) {
            return { ok: true, value: [event] };
        }
        const dated = { ...this.base(task.id, caller), type: 'update', changes: { due }, note: null };
        return { ok: true, value: [dated, event] };
    }
    created(by, id, fields) {
        if (!fields.ok) {
            return fields;
        }
        const event = { ...this.base(id, by), type: 'create', task: fields.value };
        return { ok: true, value: event };
    }
    base(id, by) {
        return { v: TASK_LINE_VERSION, id, at: new Date(this.deps.clock.now()).toISOString(), by };
    }
    /** A write by a session of this team: refused unless the caller is on the roster. */
    commit(caller, decide) {
        return this.asCaller(caller, () => this.write(decide));
    }
    /** Runs `write` for a session of this team: refused unless the caller is on the roster. */
    async asCaller(caller, write) {
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
    writeNew(decide) {
        return this.deps.numbering.issue((floor) => this.write((snapshot, elsewhere) => decide(snapshot, `T${Math.max(taskNumber(snapshot.state.nextId), floor)}`, elsewhere)));
    }
    /**
     * Read the tasks the team tree's other registers hold, which their own locks guard, so before this register's;
     * then under the lock: refuse newer data, read the working set, decide on the events (one; a due date and a
     * status; or an asked task and the status that waits on it), append them, rotate the log when it is due and the
     * team has not turned that off, and return the task after the events.
     */
    async write(decide) {
        const elsewhere = await this.deps.elsewhere.read();
        return this.deps.mutex.run(async () => {
            const snapshot = await this.writableSnapshot();
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
    /** The working set, under the lock; throws when the log holds lines of a newer teamrig, which no write may follow. */
    async writableSnapshot() {
        const snapshot = await this.deps.log.read();
        if (!isWritable(snapshot.read)) {
            throw new NewerDataError(this.deps.log.path, snapshot.read.newestVersion, EVENT_VERSION);
        }
        return snapshot;
    }
    /**
     * None when the team turned automatic archiving off. A rotation that fails leaves the write saved and the
     * files readable (rotate.ts): it is reported, never thrown.
     */
    async rotation(written) {
        if (!this.deps.autoArchive) {
            return { kind: 'none' };
        }
        try {
            const plan = await this.deps.log.rotateIfDue(written, new Date(this.deps.clock.now()), this.deps.zone);
            return plan === null ? { kind: 'none' } : { kind: 'rotated', segment: plan.segment, retired: plan.compaction.retiredNow.length };
        }
        catch (error) {
            return { kind: 'failed', error: errorMessage(error) };
        }
    }
}
/** The other active pinned tasks of `owner`, which a pin on `pinned` moves down: one pin per owner (T637). */
function otherPins(pinned, owner, state) {
    return [...state.tasks.values()].filter((task) => task.id !== pinned.id && task.owner === owner && task.pin !== null && ACTIVE_STATUSES.includes(task.status));
}
/** One event, as the list a write takes. */
function single(verdict) {
    return verdict.ok ? { ok: true, value: [verdict.value] } : verdict;
}
/**
 * The decision on a task of the working set. An id another register of the team tree holds is that team's task,
 * which only its own sessions change; so is one that moved to a team this register's tree read does not reach. An id
 * below the next one that is in none may be a task a compaction retired: it is named as such, as this teamrig changes
 * only tasks in the working set.
 */
function onTask(snapshot, elsewhere, id, decide) {
    const task = snapshot.state.tasks.get(id);
    if (task !== undefined) {
        return decide(task);
    }
    const away = elsewhere.get(id);
    if (away !== undefined) {
        return { ok: false, error: `${id} is team ${away.team}'s task (owner ${away.task.owner}): only a session of team ${away.team} changes it` };
    }
    const movedTo = snapshot.state.moved.get(id);
    if (movedTo !== undefined) {
        return { ok: false, error: `${id} moved to team ${movedTo}: only a session of team ${movedTo} changes it` };
    }
    const archived = snapshot.retired !== null && taskNumber(id) < taskNumber(snapshot.state.nextId);
    return { ok: false, error: archived ? `no task ${id} in the working set: if it was finished long ago it is archived (teamrig show ${id})` : `no task ${id}` };
}
