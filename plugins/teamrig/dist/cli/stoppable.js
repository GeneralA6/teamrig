import { endedText } from "../delivery/starter-watch.js";
import { EXIT } from "./runtime.js";
/**
 * Watches the processes that started this one, so a run whose launching shell ends (Claude Code's reaper ends a Bash
 * tool's shell alone, and on Windows what it started runs on) neither takes the host lock nor runs on holding it; said
 * when the system would not list them, since the run then goes on as before.
 */
export async function watchStarters(runtime, say) {
    const watching = await runtime.starters.watch();
    if (watching.starters.length === 0) {
        say('could not list the processes that started this one: the step runs on if its shell ends');
    }
    return watching;
}
/** What `running` settles to; undefined when `stop` aborted first, since once the shell is gone no one reads why it ended. */
export async function unlessStopped(stop, running) {
    try {
        return await running;
    }
    catch (error) {
        if (stop.aborted) {
            return undefined;
        }
        throw error;
    }
}
/** The end of a run whose launching shell ended while it waited for the host lock: said, and STOPPED, as nothing ran. */
export function stoppedWhileWaiting(runtime, say, watching) {
    say(`its launching shell ended (${endedText(watching)}) while it waited: no one waits for it any more`);
    runtime.out.stdout('STOPPED before the host lock was free: nothing ran');
    return EXIT.failed;
}
/** `stop`, or the first of `stop` and `own` to abort when the caller passed its own. */
function eitherStop(stop, own) {
    return own === undefined ? stop : AbortSignal.any([stop, own]);
}
/** `lock`, whose wait rejects with the stop's reason once `stop` aborts, releasing what it took (`HostLock.acquire`). */
export function stoppableLock(lock, stop) {
    return {
        acquire: (session, purpose, maxWaitMs, pollMs, onWait, share, own) => lock.acquire(session, purpose, maxWaitMs, pollMs, onWait, share, eitherStop(stop, own)),
        release: (held) => lock.release(held),
    };
}
/** `sleep`, rejecting with the stop's reason once `stop` has aborted, before the sleep or by its end. */
export function stoppableSleep(sleep, stop) {
    return async (ms) => {
        stop.throwIfAborted();
        await sleep(ms);
        stop.throwIfAborted();
    };
}
/** `steps`, each step killed with its tree once `stop` aborts. */
export function stoppableSteps(steps, stop) {
    return { run: (request) => steps.run({ ...request, stop: eitherStop(stop, request.stop) }) };
}
/** `hooks`, each hook killed with its tree once `stop` aborts. */
export function stoppableHooks(hooks, stop) {
    return { run: (request) => hooks.run({ ...request, stop: eitherStop(stop, request.stop) }) };
}
