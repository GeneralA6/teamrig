import { errorMessage } from "../core/guards.js";
import { NewerDataError } from "../core/jsonl.js";
import { EVENT_VERSION } from "./events.js";
import { foldEvents, taskNumber } from "./fold.js";
import { NO_SKILL } from "./policy.js";
import { isWritable } from "./snapshot.js";
/**
 * The register's write path: under the lock, read the log, replay it, apply the team policy,
 * append one event and return the task as it now stands. Reads take no lock.
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
        return this.commit(caller, ({ state }) => this.created(caller, state.nextId, this.deps.policy.add(input, state)));
    }
    /**
     * A task from the parent team's lead, `parentLead` being its `<team>/<id>`. The tree's rules decide
     * who that may be, so this team's roster check is skipped; the event names that lead as its writer.
     */
    addFromParent(parentLead, input) {
        return this.write(({ state }) => this.created(parentLead, state.nextId, this.deps.policy.addFromParent(input, state)));
    }
    async setStatus(caller, id, input) {
        const skill = input.skill?.trim();
        const skillExists = skill === undefined || skill === '' || skill === NO_SKILL || (await this.deps.skills.exists(skill));
        return this.commit(caller, (snapshot) => onTask(snapshot, id, (task) => {
            const change = this.deps.policy.setStatus(task, caller, input, skillExists);
            if (!change.ok) {
                return change;
            }
            const event = { ...this.base(id, caller), type: 'status', ...change.value };
            return { ok: true, value: event };
        }));
    }
    update(caller, id, changes, note) {
        return this.commit(caller, (snapshot) => onTask(snapshot, id, (task) => {
            const change = this.deps.policy.update(task, caller, changes, note);
            if (!change.ok) {
                return change;
            }
            const event = { ...this.base(id, caller), type: 'update', ...change.value };
            return { ok: true, value: event };
        }));
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
     * Under the lock: refuse newer data, read the working set, decide on one event, append it, rotate the log
     * when it is due and the team has not turned that off, and return the task after the event.
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
            const event = decision.value;
            await this.deps.log.append(event);
            const task = foldEvents([event], [], snapshot.state).tasks.get(event.id);
            if (task === undefined) {
                throw new Error(`${event.id} is missing after its own write`);
            }
            return { ok: true, value: { task, event, rotation: await this.rotation(snapshot) } };
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
function onTask(snapshot, id, decide) {
    const task = snapshot.state.tasks.get(id);
    if (task !== undefined) {
        return decide(task);
    }
    const archived = snapshot.retired !== null && taskNumber(id) < taskNumber(snapshot.state.nextId);
    return { ok: false, error: archived ? `no task ${id} in the working set: if it was finished long ago it is archived (teamrig show ${id})` : `no task ${id}` };
}
