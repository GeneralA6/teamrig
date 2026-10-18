import { appendHeavy } from "./ledger.js";
import { exitCodeOf } from "./steps.js";
/** The exit code recorded for a step that could not start, as a missing folder makes it. */
export const NOT_STARTED_EXIT = 1;
/** Runs a heavy step, its start and its end each a ledger record; a step that could not start is recorded as exit 1 and its error rethrown. */
export async function runRecorded(ports, ledger, step) {
    const start = {
        type: 'heavy',
        id: ports.newId(),
        session: step.session,
        what: step.what,
        startedAt: new Date(ports.clock.now()).toISOString(),
        endedAt: null,
        exitCode: null,
    };
    await appendHeavy(ports.files, ledger, start);
    let end;
    try {
        end = await ports.steps.run(step.request);
        return end;
    }
    finally {
        const endedAt = new Date(ports.clock.now()).toISOString();
        await appendHeavy(ports.files, ledger, { ...start, endedAt, exitCode: end === undefined ? NOT_STARTED_EXIT : exitCodeOf(end) });
    }
}
