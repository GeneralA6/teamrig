import { HEAVY_TTL_MARGIN_MINUTES } from "../../config/defaults.js";
import { holderText } from "../../coordinator/host-lock.js";
import { coordinatorPlaces } from "../../coordinator/places.js";
import { runRecorded } from "../../coordinator/recorded-step.js";
import { heavyCutoffReason, minutesText } from "../../coordinator/schedule.js";
import { exitCodeOf, TIMED_OUT_EXIT } from "../../coordinator/steps.js";
import { commandLine } from "../../test-run/shell.js";
import { requiredFlag, UsageError } from "../args.js";
import { hostLockOf, logLine } from "../coordinator-ports.js";
import { callerOf, commandWordsOf } from "../inputs.js";
import { openTeamKit, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
const MINUTE_MS = 60_000;
/** `--max-minutes`: whole minutes from 1 to the lock's TTL less its margin, so the step never outlives its lock; unset, the config's. */
function maxRunMinutesOf(args, heavy) {
    const text = args.flags.get('max-minutes');
    if (text === undefined) {
        return heavy.maxRunMinutes;
    }
    const longest = heavy.lockTtlMinutes - HEAVY_TTL_MARGIN_MINUTES;
    const minutes = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (!(minutes >= 1 && minutes <= longest)) {
        throw new UsageError(`--max-minutes is a whole number from 1 to ${longest} (coordinator.heavy.lockTtlMinutes less ${HEAVY_TTL_MARGIN_MINUTES})`);
    }
    return minutes;
}
function refuseAfterCutoff(runtime, cutoffUtc) {
    const reason = heavyCutoffReason(runtime.clock.now(), cutoffUtc);
    if (reason !== undefined) {
        throw new RefusedError(reason);
    }
}
/** The last line: DONE, FAILED or TIMED OUT, with the exit code the ledger recorded. */
function report(runtime, end, maxRunMinutes) {
    switch (end.kind) {
        case 'timedOut':
            logLine(runtime, `timed out after ${minutesText(maxRunMinutes)}: killed its process tree`);
            runtime.out.stdout(`TIMED OUT killed, recorded as exit ${TIMED_OUT_EXIT}`);
            return EXIT.failed;
        case 'signal':
            runtime.out.stdout(`FAILED stopped by ${end.signal}, recorded as exit ${exitCodeOf(end)}`);
            return EXIT.failed;
        case 'exited':
            runtime.out.stdout(end.code === 0 ? 'DONE exit 0' : `FAILED exit ${end.code}`);
            return end.code === 0 ? EXIT.ok : EXIT.failed;
    }
}
/**
 * `teamrig heavy --what <label> -- <command ...>`: runs one heavy step (a build, a test run, a database script)
 * under the host lock, so the host's heavy steps run one at a time. Refused from `coordinator.schedule.heavyCutoffUtc`
 * to midnight UTC, also when the wait for the lock ran past it, and when the lock is still held after
 * `coordinator.heavy.waitMinutes`. The step is killed with every process it started after `maxRunMinutes`
 * (`--max-minutes`), and its start and end go to the coordinator's ledger. Exit 0 when the command passed, 1 when it
 * failed or was killed, 2 refused.
 */
export async function heavy(args, runtime) {
    const words = commandWordsOf(args);
    const what = requiredFlag(args.flags, 'what');
    const caller = callerOf(args.flags, runtime.env);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const session = sessionIdOf(await rosterOf(runtime, kit, config), caller);
    const { coordinator } = config;
    const maxRunMinutes = maxRunMinutesOf(args, coordinator.heavy);
    refuseAfterCutoff(runtime, coordinator.schedule.heavyCutoffUtc);
    const places = coordinatorPlaces(coordinator, kit.paths);
    const lock = hostLockOf(runtime, places.hostLock, coordinator.heavy);
    const taking = await lock.acquire(session, `heavy: ${what}`, coordinator.heavy.waitMinutes * MINUTE_MS, coordinator.wait.pollSeconds * 1_000, (holder) => logLine(runtime, `waiting for the host lock: ${holderText(holder)}`));
    if (taking.kind === 'busy') {
        throw new RefusedError(`host lock still held by ${holderText(taking.holder)}`);
    }
    try {
        refuseAfterCutoff(runtime, coordinator.schedule.heavyCutoffUtc);
        logLine(runtime, `running: ${what} (killed after ${minutesText(maxRunMinutes)})`);
        const request = { command: commandLine(words, runtime.platform), cwd: runtime.cwd, env: runtime.env, timeoutMs: maxRunMinutes * MINUTE_MS };
        const end = await runRecorded(runtime, places.ledger, { session, what, request });
        return report(runtime, end, maxRunMinutes);
    }
    finally {
        await lock.release(taking.lock);
    }
}
