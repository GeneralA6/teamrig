import { errorMessage } from "../../core/guards.js";
import { HiringLog } from "../../hiring/log.js";
import { activeHires } from "../../hiring/record.js";
import { SessionAskStore } from "../../core/session-asks.js";
import { ownsOpenTask, lastTaskAskDue, lastTaskAskReason } from "../../hiring/last-task-ask.js";
import { JsonlEventLog } from "../../register/store.js";
import { RefreshStore } from "../../refresh/store.js";
/**
 * The automatic ask for a hired session's handover (hiring/last-task-ask.ts) on the command line: `set` records it
 * when a close leaves a hired session with no open task, and the session's Stop hook turns it into a one-time block.
 */
/**
 * After a `set` that closed a task (done or dropped): records the ask for its owner when `lastTaskAskDue` says so.
 * The task is already closed, so a failure here only warns and the exit stays 0.
 */
export async function markLastTaskAsk(runtime, config, paths, written) {
    if (config.hiring.policy !== 'automatic') {
        return;
    }
    const { task, state } = written;
    try {
        const { records } = await new HiringLog(runtime.files, paths.hires).read();
        if (lastTaskAskDue({ config, hires: activeHires(records), task, tasks: state.tasks.values() })) {
            await new SessionAskStore(runtime.files, paths.lastTaskAsks).set(task.owner, { task: task.id, at: new Date(runtime.clock.now()).toISOString() });
        }
    }
    catch (error) {
        runtime.out.stderr(`WARN ${task.id} is closed, but the ask for ${task.owner} to write its handover was not recorded: ${errorMessage(error)}`);
    }
}
/**
 * The Stop hook's block reason for session `id`, on the team, from its due ask; undefined without one, under
 * another policy, or once the session owns an open task again. The ask is removed before the reason is returned,
 * so it blocks one stop only. Most stops read one missing file; the register is read only when an ask is due.
 */
export async function lastTaskAskReasonOf(runtime, config, paths, id) {
    if (config.hiring.policy !== 'automatic') {
        return undefined;
    }
    const store = new SessionAskStore(runtime.files, paths.lastTaskAsks);
    const ask = await store.get(id);
    if (ask === undefined) {
        return undefined;
    }
    await store.clear(id);
    const snapshot = await new JsonlEventLog(runtime.files, paths.events).read();
    if (ownsOpenTask(snapshot.state.tasks.values(), id)) {
        return undefined;
    }
    return lastTaskAskReason(ask, new RefreshStore(runtime.files, paths).handoverPath(id));
}
