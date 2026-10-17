import { errorMessage } from "../core/guards.js";
import { NewerDataError } from "../core/jsonl.js";
import { EVENT_VERSION } from "./events.js";
import { foldEvents, taskNumber } from "./fold.js";
import { GITHUB_ACTOR, NO_SKILL } from "./policy.js";
import { isWritable } from "./snapshot.js";
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
    add(caller, input) {
        return this.commit(caller, ({ state }) => single(this.created(caller, state.nextId, this.deps.policy.add(input, state))));
    }
    /**
     * A task from the parent team's lead, `parentLead` being its `<team>/<id>`. The tree's rules decide
     * who that may be, so this team's roster check is skipped; the event names that lead as its writer.
     */
    addFromParent(parentLead, input) {
        return this.write(({ state }) => single(this.created(parentLead, state.nextId, this.deps.policy.addFromParent(input, state))));
    }
    /**
     * The GitHub import's writes (github/sync.ts): each is judged again under the lock, on the register as it
     * then stands, and written by GITHUB_ACTOR, which is on no roster. The policy limits them to the import's
     * own tasks: a new one per issue, its title and priority, and open, done or dropped as GitHub has it.
     */
    importAdd(input) {
        return this.write(({ state }) => single(this.created(GITHUB_ACTOR, state.nextId, this.deps.policy.importAdd(input, state))));
    }
    importUpdate(id, changes, note) {
        return this.write((snapshot) => onTask(snapshot, id, (task) => {
            const change = this.deps.policy.importUpdate(task, changes, note);
            return single(change.ok ? { ok: true, value: { ...this.base(id, GITHUB_ACTOR), type: 'update', ...change.value } } : change);
        }));
    }
    importStatus(id, input) {
        return this.write((snapshot) => onTask(snapshot, id, (task) => {
            const change = this.deps.policy.importStatus(task, input);
            return single(change.ok ? { ok: true, value: { ...this.base(id, GITHUB_ACTOR), type: 'status', ...change.value } } : change);
        }));
    }
    async setStatus(caller, id, input) {
        const skillExists = await this.skillExists(input);
        return this.commit(caller, (snapshot) => onTask(snapshot, id, (task) => this.statusEvents(task, caller, input, { state: snapshot.state, now: new Date(this.deps.clock.now()), skillExists })));
    }
    /**
     * `set <id> --status waiting --ask <session> --text "<the work>"`, in one write: the task asked of that session, then
     * the caller's task set waiting on it (after any `--waits` reasons given), so neither lands without the other. The
     * status is judged on the register with the asked task in it; with no `--note`, the work asked for is the note.
     */
    async ask(caller, id, ask, input) {
        const skillExists = await this.skillExists(input);
        const written = await this.commit(caller, (snapshot) => onTask(snapshot, id, (task) => {
            const fields = this.deps.policy.ask(task, caller, ask, input, snapshot.state);
            if (!fields.ok) {
                return fields;
            }
            const askedId = snapshot.state.nextId;
            const created = { ...this.base(askedId, caller), type: 'create', task: fields.value };
            const state = foldEvents([created], [], snapshot.state);
            const waits = [...(input.waits ?? []), { kind: 'task', id: askedId }];
            const asking = { ...input, waits, note: input.note ?? fields.value.title };
            const status = this.statusEvents(task, caller, asking, { state, now: new Date(this.deps.clock.now()), skillExists });
            return status.ok ? { ok: true, value: [created, ...status.value] } : status;
        }));
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
    update(caller, id, changes, note) {
        return this.commit(caller, (snapshot) => onTask(snapshot, id, (task) => {
            const change = this.deps.policy.update(task, caller, changes, note, snapshot.state);
            if (!change.ok) {
                return change;
            }
            const event = { ...this.base(id, caller), type: 'update', ...change.value };
            return { ok: true, value: [event] };
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
        return { v: EVENT_VERSION, id, at: new Date(this.deps.clock.now()).toISOString(), by };
    }
    /** A write by a session of this team: refused unless the caller is on the roster. */
    async commit(caller, decide) {
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
    write(decide) {
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
    async rotation(written) {
        if (!this.deps.autoArchive) {
            return { kind: 'none' };
        }
        try {
            const plan = await this.deps.log.rotateIfDue(written, new Date(this.deps.clock.now()));
            return plan === null ? { kind: 'none' } : { kind: 'rotated', segment: plan.segment, retired: plan.compaction.retiredNow.length };
        }
        catch (error) {
            return { kind: 'failed', error: errorMessage(error) };
        }
    }
}
/**
 * The decision on a task of the working set. An id below the next one that is not in it may be a task a
 * compaction retired: it is named as such, as this teamrig changes only tasks in the working set.
 */
/** One event, as the list a write takes. */
function single(verdict) {
    return verdict.ok ? { ok: true, value: [verdict.value] } : verdict;
}
function onTask(snapshot, id, decide) {
    const task = snapshot.state.tasks.get(id);
    if (task !== undefined) {
        return decide(task);
    }
    const archived = snapshot.retired !== null && taskNumber(id) < taskNumber(snapshot.state.nextId);
    return { ok: false, error: archived ? `no task ${id} in the working set: if it was finished long ago it is archived (teamrig show ${id})` : `no task ${id}` };
}
