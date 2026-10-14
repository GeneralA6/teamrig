import { NewerDataError } from "../core/jsonl.js";
import { EVENT_VERSION } from "./events.js";
import { foldEvents } from "./fold.js";
import { NO_SKILL } from "./policy.js";
import { isWritable } from "./store.js";
/** The register as it stands, read without the lock, as every read is. */
export async function readSnapshot(log) {
    const read = await log.read();
    return { state: foldEvents(read.events, read.seenIds), read };
}
/**
 * The register's write path: under the lock, read the log, replay it, apply the team policy,
 * append one event and return the task as it now stands. Reads take no lock.
 */
export class Register {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    snapshot() {
        return readSnapshot(this.deps.log);
    }
    add(caller, input) {
        return this.commit(caller, (state) => this.created(caller, state, this.deps.policy.add(input, state)));
    }
    /**
     * A task from the parent team's lead, `parentLead` being its `<team>/<id>`. The tree's rules decide
     * who that may be, so this team's roster check is skipped; the event names that lead as its writer.
     */
    addFromParent(parentLead, input) {
        return this.write((state) => this.created(parentLead, state, this.deps.policy.addFromParent(input, state)));
    }
    async setStatus(caller, id, input) {
        const skill = input.skill?.trim();
        const skillExists = skill === undefined || skill === '' || skill === NO_SKILL || (await this.deps.skills.exists(skill));
        return this.commit(caller, (state) => onTask(state, id, (task) => {
            const change = this.deps.policy.setStatus(task, caller, input, skillExists);
            if (!change.ok) {
                return change;
            }
            const event = { ...this.base(id, caller), type: 'status', ...change.value };
            return { ok: true, value: event };
        }));
    }
    update(caller, id, changes, note) {
        return this.commit(caller, (state) => onTask(state, id, (task) => {
            const change = this.deps.policy.update(task, caller, changes, note);
            if (!change.ok) {
                return change;
            }
            const event = { ...this.base(id, caller), type: 'update', ...change.value };
            return { ok: true, value: event };
        }));
    }
    created(by, state, fields) {
        if (!fields.ok) {
            return fields;
        }
        const event = { ...this.base(state.nextId, by), type: 'create', task: fields.value };
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
    /** Under the lock: refuse newer data, replay, decide on one event, append it, return the task after it. */
    write(decide) {
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
function onTask(state, id, decide) {
    const task = state.tasks.get(id);
    return task === undefined ? { ok: false, error: `no task ${id}` } : decide(task);
}
