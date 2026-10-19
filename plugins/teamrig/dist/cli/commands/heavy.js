import { HEAVY_TTL_MARGIN_MINUTES } from "../../config/defaults.js";
import { holderText, underLock, waitText } from "../../coordinator/host-lock.js";
import { coordinatorPlaces } from "../../coordinator/places.js";
import { runRecorded } from "../../coordinator/recorded-step.js";
import { heavyCutoffReason, minutesText } from "../../coordinator/schedule.js";
import { exitCodeOf, TIMED_OUT_EXIT } from "../../coordinator/steps.js";
import { ENV } from "../../core/home.js";
import { commandLine } from "../../test-run/shell.js";
import { requiredFlag, UsageError } from "../args.js";
import { hostLockOf, logLine } from "../coordinator-ports.js";
import { commandWordsOf, sessionRef } from "../inputs.js";
import { openTeamKit, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { envSession, markedSessionOf } from "./hook-input.js";
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
 * The lock of the step that started this one, from `$TEAMRIG_HOST_LOCK`, while that step still holds it; undefined when
 * the variable is unset or names no live lock (a leftover in a shell), which is said, since the step then waits as usual.
 */
async function parentLockOf(runtime, lock) {
    const token = runtime.env[ENV.hostLock]?.trim();
    if (token === undefined || token === '') {
        return undefined;
    }
    const held = await lock.heldWith(token);
    if (held === undefined) {
        logLine(runtime, `$${ENV.hostLock} names no live host lock: taking the lock as usual`);
    }
    return held;
}
/**
 * The step's session: `--session`, else `$TEAMRIG_SESSION`, else the parent step's (a git hook's checks under
 * `heavy -- git commit` or an integrate's push), else the session this Claude Code tab is bound to, so a hook
 * that wraps its checks in `heavy` needs no session of its own.
 */
async function sessionOf(args, runtime, kit, roster, parent) {
    const named = args.flags.get('session') ?? envSession(runtime);
    if (named !== undefined) {
        return sessionIdOf(roster, sessionRef('--session', named));
    }
    const found = parent?.session ?? (await markedSessionOf(runtime, kit, roster, runtime.env[ENV.claudeSession]?.trim() ?? null));
    if (found === undefined) {
        throw new UsageError(`--session (or $${ENV.session}) is required outside a tab bound to a session`);
    }
    return found;
}
/**
 * A step started by a step that holds the host lock runs at once under that lock: it is part of its parent, whose
 * cutoff check and ledger record cover it, and waiting for the lock would wait on its own parent.
 */
async function runUnderParent(runtime, parent, what, words, maxRunMinutes) {
    logLine(runtime, `running: ${what} under the host lock of ${holderText({ kind: 'held', info: parent })} (killed after ${minutesText(maxRunMinutes)})`);
    const end = await runtime.steps.run({ command: commandLine(words, runtime.platform), cwd: runtime.cwd, env: runtime.env, timeoutMs: maxRunMinutes * MINUTE_MS });
    return report(runtime, end, maxRunMinutes);
}
/**
 * `teamrig heavy --what <label> -- <command ...>`: runs one heavy step (a build, a test run, a database script)
 * under the host lock, so the host's heavy steps run one at a time. Refused from `coordinator.schedule.heavyCutoffUtc`
 * to midnight UTC, also when the wait for the lock ran past it, and when the lock is still held after
 * `coordinator.heavy.waitMinutes`. The step is killed with every process it started after `maxRunMinutes`
 * (`--max-minutes`), and its start and end go to the coordinator's ledger. Its processes get `$TEAMRIG_HOST_LOCK`,
 * so a `heavy` among them (a git hook's checks) runs at once under this lock. Exit 0 when the command passed, 1 when
 * it failed or was killed, 2 refused.
 */
export async function heavy(args, runtime) {
    const words = commandWordsOf(args);
    const what = requiredFlag(args.flags, 'what');
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const { coordinator } = config;
    const maxRunMinutes = maxRunMinutesOf(args, coordinator.heavy);
    const places = coordinatorPlaces(coordinator, kit.paths);
    const lock = hostLockOf(runtime, places.hostLock, coordinator.heavy);
    const parent = await parentLockOf(runtime, lock);
    const session = await sessionOf(args, runtime, kit, await rosterOf(runtime, kit, config), parent);
    if (parent !== undefined) {
        return runUnderParent(runtime, parent, what, words, maxRunMinutes);
    }
    refuseAfterCutoff(runtime, coordinator.schedule.heavyCutoffUtc);
    const taking = await lock.acquire(session, `heavy: ${what}`, coordinator.heavy.waitMinutes * MINUTE_MS, coordinator.wait.pollSeconds * 1_000, (holder, ahead) => logLine(runtime, `waiting for the host lock: ${waitText(holder, ahead)}`));
    if (taking.kind === 'busy') {
        throw new RefusedError(`host lock still held by ${holderText(taking.holder)}`);
    }
    try {
        refuseAfterCutoff(runtime, coordinator.schedule.heavyCutoffUtc);
        logLine(runtime, `running: ${what} (killed after ${minutesText(maxRunMinutes)})`);
        const request = { command: commandLine(words, runtime.platform), cwd: runtime.cwd, env: underLock(runtime.env, taking.lock), timeoutMs: maxRunMinutes * MINUTE_MS };
        const end = await runRecorded(runtime, places.ledger, { session, what, request });
        return report(runtime, end, maxRunMinutes);
    }
    finally {
        await lock.release(taking.lock);
    }
}
