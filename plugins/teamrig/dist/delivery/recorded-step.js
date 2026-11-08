import { KIT_VERSION } from "../core/version.js";
import { appendRecord } from "./ledger.js";
import { holdersText } from "./memory.js";
import { processRequest } from "./process-request.js";
import { exitCodeOf, STOPPED_EXIT, TIMED_OUT_EXIT } from "./steps.js";
/** The exit code recorded for a step that could not start, as a missing folder makes it. */
export const NOT_STARTED_EXIT = 1;
/**
 * Marks for the queued steps one taking of the host lock runs, in order: only the first carries the taking's wait (when
 * it began, the ms by cause and the host's free memory then), since a later step's wait would count the steps before it.
 */
export function marksOfTaking(owner, waited) {
    let first = waited;
    return (what) => {
        const mark = first === undefined ? { ...owner, what } : { ...owner, what, ...first };
        first = undefined;
        return mark;
    };
}
/** An owner's request as its records store it: `kind`, and `task` and its `priority` when it names them. */
function requestFieldsOf(owner) {
    return processRequest(owner.kind, owner.task, owner.priority);
}
/** A mark's wait as the start record stores it: `queuedAt` as an ISO time, `waits` only when any cause took time. */
function waitFieldsOf(mark) {
    return {
        ...(mark.queuedAt === undefined ? {} : { queuedAt: new Date(mark.queuedAt).toISOString() }),
        ...(mark.waits === undefined || Object.keys(mark.waits).length === 0 ? {} : { waits: mark.waits }),
        ...(mark.queueFreeMb === undefined ? {} : { queueFreeMb: mark.queueFreeMb }),
    };
}
/** The end of a step the kit killed, at its time limit or as its launching shell ended, or that a shell reports so. */
function killed(exitCode) {
    return exitCode === TIMED_OUT_EXIT || exitCode === STOPPED_EXIT;
}
/** The host's memory at a kill: its free memory and, where the host reads it, its commit charge. */
async function atKill(memory) {
    const endFreeMb = memory.freeMb();
    const charge = await memory.commit();
    return charge === undefined ? { endFreeMb } : { endFreeMb, commitMb: charge.usedMb, commitLimitMb: charge.limitMb };
}
/**
 * Runs `work` as one queued step, its start and its end each a ledger record naming this teamrig's version, the end
 * with the exit code `exitOf` reads from its result; work that throws is recorded as exit 1 and its error rethrown.
 * Unless `memorySampleSeconds` is 0, the tree of `pid` is watched while it runs: the end record carries the most it
 * held, the host's free memory at the start and at its least, and for a killed step (exit 124 or 129) the free memory
 * and commit charge at the kill.
 */
export async function recordQueuedStep(ports, setup, mark, work, exitOf) {
    const ledger = setup.places.ledger;
    const sampleMs = setup.delivery.queue.memorySampleSeconds * 1_000;
    const start = {
        type: 'heavy',
        id: ports.newId(),
        session: mark.session,
        what: mark.what,
        ...requestFieldsOf(mark),
        kit: KIT_VERSION,
        ...waitFieldsOf(mark),
        ...(mark.shared === true ? { shared: true } : {}),
        startedAt: new Date(ports.clock.now()).toISOString(),
        endedAt: null,
        exitCode: null,
    };
    await appendRecord(ports.files, ledger, start);
    const watching = sampleMs === 0 ? undefined : ports.memory.watch(ports.pid, sampleMs);
    let exitCode = NOT_STARTED_EXIT;
    try {
        const result = await work();
        exitCode = exitOf(result);
        return result;
    }
    finally {
        const peaks = (await watching?.stop()) ?? {};
        const kill = watching !== undefined && killed(exitCode) ? await atKill(ports.memory) : {};
        const endedAt = new Date(ports.clock.now()).toISOString();
        await appendRecord(ports.files, ledger, { ...start, endedAt, exitCode, ...peaks, ...kill });
    }
}
/** The waits on host memory: a refusal after one names the programs holding the most, since most of it is held outside the queue. */
const MEMORY_CAUSES = new Set(['memory', 'commit']);
/** `reason` with the host's top memory holders after it; unchanged when they cannot be listed. */
async function withHolders(reason, memory) {
    const holders = await memory.holders();
    const named = holders === undefined ? undefined : holdersText(holders);
    return named === undefined ? reason : `${reason}; ${named}`;
}
/**
 * Records a queued step that waited and then did not run: its wait by cause, the last reason it waited on, and the
 * host's free memory when it began to wait and when it ended. Returns the reason to print, as recorded: when the last
 * wait was on host memory, the mark's reason with the top memory holders after it. A step refused before anything held
 * it (the cutoff before it queued, a refusing check at the first ask) records nothing, it never waited, and keeps the
 * mark's reason.
 */
export async function recordRefusal(ports, ledger, waits, mark) {
    const lastWait = waits.last();
    if (lastWait === undefined) {
        return mark.reason;
    }
    const waited = waits.end();
    const reason = MEMORY_CAUSES.has(lastWait.cause) ? await withHolders(mark.reason, ports.memory) : mark.reason;
    await appendRecord(ports.files, ledger, {
        type: 'refusal',
        id: ports.newId(),
        session: mark.session,
        what: mark.what,
        ...requestFieldsOf(mark),
        kit: KIT_VERSION,
        queuedAt: new Date(waited.queuedAt).toISOString(),
        endedAt: new Date(ports.clock.now()).toISOString(),
        outcome: mark.outcome,
        reason,
        ...(Object.keys(waited.waits).length === 0 ? {} : { waits: waited.waits }),
        lastWait,
        ...(waited.queueFreeMb === undefined ? {} : { queueFreeMb: waited.queueFreeMb }),
        endFreeMb: ports.memory.freeMb(),
    });
    return reason;
}
/** Runs a queued step as `recordQueuedStep` records it; a step that could not start is recorded as exit 1 and its error rethrown. */
export async function runRecorded(ports, setup, step) {
    return recordQueuedStep(ports, setup, step, () => ports.steps.run(step.request), exitCodeOf);
}
