import { appendRecord } from "./ledger.js";
import { exitCodeOf } from "./steps.js";
/** The exit code recorded for a step that could not start, as a missing folder makes it. */
export const NOT_STARTED_EXIT = 1;
/**
 * Runs `work` as one heavy step, its start and its end each a ledger record, the end with the exit code `exitOf`
 * reads from its result; work that throws is recorded as exit 1 and its error rethrown. With `watch`, the end
 * record carries the most the step's process tree held and the least free memory the host had while it ran.
 */
export async function recordHeavy(ports, ledger, mark, work, exitOf, watch) {
    const start = {
        type: 'heavy',
        id: ports.newId(),
        session: mark.session,
        what: mark.what,
        ...(mark.queuedAt === undefined ? {} : { queuedAt: new Date(mark.queuedAt).toISOString() }),
        ...(mark.shared === true ? { shared: true } : {}),
        startedAt: new Date(ports.clock.now()).toISOString(),
        endedAt: null,
        exitCode: null,
    };
    await appendRecord(ports.files, ledger, start);
    const watching = watch?.memory.watch(watch.root, watch.intervalMs);
    let exitCode = NOT_STARTED_EXIT;
    try {
        const result = await work();
        exitCode = exitOf(result);
        return result;
    }
    finally {
        const peaks = (await watching?.stop()) ?? {};
        const endedAt = new Date(ports.clock.now()).toISOString();
        await appendRecord(ports.files, ledger, { ...start, endedAt, exitCode, ...peaks });
    }
}
/**
 * Runs a heavy step, its start and its end each a ledger record, its memory watched with `watch`; a step that could
 * not start is recorded as exit 1 and its error rethrown.
 */
export async function runRecorded(ports, ledger, step, watch) {
    return recordHeavy(ports, ledger, step, () => ports.steps.run(step.request), exitCodeOf, watch);
}
