import { NewerDataError } from "../core/jsonl.js";
import { EVENT_VERSION } from "./events.js";
import { foldEvents } from "./fold.js";
import { NO_SKILL } from "./policy.js";
import { isWritable } from "./store.js";
/**
 * The register's write path: under the lock, read the log, replay it, apply the team policy,
 * append one event and return the task as it now stands. Reads take no lock.
 */
export class Register {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async snapshot() {
        const read = await this.deps.log.read();
        return { state: foldEvents(read.events, read.seenIds), read };
    }
    add(caller, input) {
        return this.commit(caller, (state) => {
            const fields = this.deps.policy.add(input, state);
            if (!fields.ok) {
                return fields;
            }
            const event = { ...this.base(state.nextId, caller), type: 'create', task: fields.value };
            return { ok: true, value: event };
        });
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
    base(id, by) {
        return { v: EVENT_VERSION, id, at: new Date(this.deps.clock.now()).toISOString(), by };
    }
    /** Under the lock: refuse newer data, replay, decide on one event, append it, return the task after it. */
    async commit(caller, decide) {
        const callerProblem = this.deps.policy.checkCaller(caller);
        if (callerProblem !== undefined) {
            return { ok: false, error: callerProblem };
        }
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
