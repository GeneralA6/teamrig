import { join } from 'node:path';
import { stringField } from "../core/guards.js";
import { KIT_NAME } from "../core/home.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { ACTIVE_STATUSES } from "../register/model.js";
/**
 * Under `hiring.policy` `automatic`, a hired session whose last open task closes is asked at its next turn
 * end to write its handover and retire itself. `set` records the ask; the Stop hook takes it, checks the
 * session still has no open task, and blocks once with `retireAskReason`.
 */
export const RETIRE_ASK_FORMAT = 1;
/** An ask file's content; undefined when it is damaged or from another format. */
export function parseRetireAsk(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== RETIRE_ASK_FORMAT) {
        return undefined;
    }
    const task = stringField(record, 'task');
    const at = stringField(record, 'at');
    return task === undefined || at === undefined ? undefined : { task, at };
}
export function formatRetireAsk(ask) {
    return toJsonlLine({ [VERSION_FIELD]: RETIRE_ASK_FORMAT, task: ask.task, at: ask.at });
}
/**
 * The due asks, one small file per session (`<id>.json`): `set` writes one, the session's own Stop hook
 * removes it before it asks, and `retire` removes it. Ids are session ids, checked by the roster, so they
 * are safe in a path.
 */
export class RetireAskStore {
    files;
    folder;
    constructor(files, folder) {
        this.files = files;
        this.folder = folder;
    }
    /** The session's due ask; none when there is none or its file is damaged. */
    async get(id) {
        const text = await this.files.read(this.pathOf(id));
        return text === undefined ? undefined : parseRetireAsk(text);
    }
    async set(id, ask) {
        await this.files.write(this.pathOf(id), formatRetireAsk(ask));
    }
    async clear(id) {
        await this.files.remove(this.pathOf(id));
    }
    pathOf(id) {
        return join(this.folder, `${id}.json`);
    }
}
/** Whether `session` owns a task that is not closed. */
export function ownsOpenTask(tasks, session) {
    for (const task of tasks) {
        if (task.owner === session && ACTIVE_STATUSES.includes(task.status)) {
            return true;
        }
    }
    return false;
}
/** Whether closing the task asks its owner to retire: a hired session on the team, under `automatic`, left with no open task. */
export function retireAskDue(input) {
    const { config, task } = input;
    return (config.hiring.policy === 'automatic' &&
        config.sessions.includes(task.owner) &&
        input.hires.some((hire) => hire.session === task.owner) &&
        !ownsOpenTask(input.tasks, task.owner));
}
/** The Stop hook's block reason: write the handover, then retire, unless the job goes on. */
export function retireAskReason(id, ask, handoverPath) {
    return (`Your last open task ${ask.task} is closed and hiring.policy is automatic, so your job here may be done. ` +
        `Write your handover to ${handoverPath} (what you did, where it lives, what is left), then retire: ` +
        `\`${KIT_NAME} retire ${id} --session ${id} --yes\`. If your job goes on, or retire refuses because a task came in, say so in one line and carry on.`);
}
