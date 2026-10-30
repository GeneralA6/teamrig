import { errorMessage } from "../../core/guards.js";
import { KIT_NAME } from "../../core/home.js";
import { LockBusyError } from "../../core/lock.js";
import { hooklessReader } from "../../restore/hookless.js";
import { SessionLog } from "../../sessions/log.js";
import { SessionRecordStore } from "../../sessions/record.js";
import { postToHolder, sessionNameOn } from "../holder-team.js";
import { hooklessReopenLine, hooklessReopensOf } from "../hookless-reopen.js";
import { idlePassOf, passLineOf } from "../idle-pass.js";
import { readIdlePassState } from "../idle-pass-check.js";
import { actsToStart, failedState, formatIdlePassRecord, formatIdlePassState, heldActs, isPassDue, passedState, stepsToLog, } from "../idle-pass-log.js";
import { teamZone } from "../kit.js";
import { postUrgentLine } from "../urgent-line.js";
import { sessionFoldersOf } from "./setup.js";
import { fileLockOf } from "../file-locks.js";
/** The team's reopened tabs no teamrig hook started in, from its session log and its sessions' start records. */
async function hooklessReopensNow(runtime, kit, roster, now) {
    const { records } = await new SessionLog(runtime.files, kit.paths.sessionLog).read();
    return hooklessReopensOf(records, await new SessionRecordStore(runtime.files, kit.paths).readEach(roster.ids), roster.ids, now);
}
/**
 * Runs the pass, each session in its own project folder as `teamrig sessions --pass` does by default. The pass reads
 * the host's processes and every session's record, transcript and budget; a failure there is the pass's, logged as
 * such, and must not cost the tab its wake answer.
 */
async function runPass(runtime, kit, config, roster, from, now) {
    try {
        const steps = await idlePassOf(runtime, kit, config, roster, sessionFoldersOf(runtime, config, undefined, from));
        return { kind: 'ran', steps, hookless: await hooklessReopensNow(runtime, kit, roster, now) };
    }
    catch (error) {
        return { kind: 'failed', error: errorMessage(error) };
    }
}
/**
 * Tells of each hookless reopen once: in mode `on` as an urgent line (src/cli/urgent-line.ts) from teamrig to the
 * lead, or the delivery owner for the lead's own tab (`hooklessReader`), on its team, a team above included,
 * and in both modes as a log record, with why the line was not posted. One not posted is still marked told, so a
 * refusing inbox gets no line a minute. Returns each hookless reopen's time by session, for the next pass to skip.
 */
async function tellHookless(runtime, kit, config, roster, hookless, previous, now) {
    const { mode } = config.open.idle;
    const zone = teamZone(config, runtime);
    const told = {};
    for (const reopen of hookless) {
        told[reopen.id] = reopen.at;
        if (previous?.told?.[reopen.id] === reopen.at) {
            continue;
        }
        const to = hooklessReader({ session: reopen.id }, config.roles, kit.paths.team);
        const line = hooklessReopenLine(reopen, sessionNameOn(to.team, kit.paths.team, reopen.id), roster, zone, now);
        const problem = mode === 'on' ? await postToHolder(runtime, { kit, config }, to, { from: KIT_NAME, text: line }, postUrgentLine) : undefined;
        await runtime.files.append(kit.paths.idlePassLog, formatIdlePassRecord({ kind: 'hookless', at: now, mode, id: reopen.id, line, problem }));
    }
    return told;
}
/** The internal command that makes each act (idle-act.ts). */
const ACT_COMMANDS = { close: 'idle-close', reopen: 'idle-open' };
function startProblemOf(started) {
    return started.kind === 'missing' ? 'node was not found' : started.error;
}
/** Starts one act hidden in the folder the pass read its session in; why it did not start, undefined when it did. */
async function startAct(runtime, kit, { act, id, project }) {
    const started = await runtime.processes.startHidden({
        command: runtime.self.node,
        args: [runtime.self.script, ACT_COMMANDS[act], id, '--team', kit.paths.team, '--project', project],
        cwd: project,
        env: runtime.env,
    });
    return started.kind === 'started' ? undefined : startProblemOf(started);
}
/**
 * Starts each act hidden, as hook-restart.ts starts `teamrig restart`: a close takes up to about 22 s
 * (src/open/end-tab.ts) and the mod ends a wake check at 30 s (src/mod/wake-hand.ts), so none runs inside the check.
 * Each act weighs its session again and logs its own outcome. Each is marked pending, one that did not start too, so
 * the passes after it start none on its session for `IDLE_ACT_HOLD_MS`; one that did not start is logged.
 */
async function startActs(runtime, kit, roster, acts, now) {
    const pending = {};
    for (const toStart of acts) {
        const { act, id } = toStart;
        const problem = await startAct(runtime, kit, toStart);
        pending[id] = { act, at: now };
        if (problem !== undefined) {
            const line = `FAILED to start the ${act} of ${roster.nameOf(id) ?? id} (session ${id}): ${problem}`;
            await runtime.files.append(kit.paths.idlePassLog, formatIdlePassRecord({ kind: 'act', at: now, mode: 'on', act, id, outcome: 'failed', line, before: undefined, after: undefined }));
        }
    }
    return pending;
}
/**
 * One pass, under its lock: logs the steps whose kind changed, every step once the last pass record is an hour old
 * (`stepsToLog`), or a new failure, with the host's commit charge; in mode `on` starts each act its steps ask for and
 * none pending; tells of each new hookless reopen; and keeps the state for the next pass.
 */
async function passOnce(runtime, kit, config, roster, from, previous, now) {
    const { mode } = config.open.idle;
    const { files } = runtime;
    const run = await runPass(runtime, kit, config, roster, from, now);
    if (run.kind === 'failed') {
        if (previous?.failed !== run.error) {
            await files.append(kit.paths.idlePassLog, formatIdlePassRecord({ kind: 'failed', at: now, mode, error: run.error }));
        }
        return failedState(previous, now, run.error);
    }
    const toLog = stepsToLog(previous, run.steps, now);
    if (toLog.length > 0) {
        const zone = teamZone(config, runtime);
        const steps = toLog.map((step) => ({ kind: step.kind, id: step.id, line: passLineOf(step, roster, zone) }));
        const record = { kind: 'pass', at: now, mode, commit: await runtime.memory.commit(), steps };
        await files.append(kit.paths.idlePassLog, formatIdlePassRecord(record));
    }
    const held = heldActs(previous?.pending, run.steps, now);
    const started = mode === 'on' ? await startActs(runtime, kit, roster, actsToStart(run.steps, held), now) : {};
    const told = await tellHookless(runtime, kit, config, roster, run.hookless, previous, now);
    return passedState(now, run.steps, { ...held, ...started }, told, toLog.length > 0 ? now : previous?.logged);
}
/**
 * The idle pass as `hook wake-check` runs it (T1100), unless `open.idle.mode` is off: once every `IDLE_PASS_EVERY_MS`
 * across the team, claimed under a lock no check waits for, it works out what `teamrig sessions --pass` prints and
 * appends to the team's pass log the steps whose kind changed since the last pass, and every step once its last
 * pass record is an hour old, with the host's commit charge;
 * a failed pass logs its error once until the error changes. It logs once each reopened tab no teamrig hook started
 * in (src/cli/hookless-reopen.ts). In dry-run it changes nothing else; in `on` it starts the closes and the reopen
 * its steps ask for, and tells the lead of each hookless reopen with an urgent line. With mode off it reads nothing.
 */
export async function runIdlePass(runtime, kit, config, roster, from) {
    if (config.open.idle.mode === 'off') {
        return;
    }
    const now = runtime.clock.now();
    if (!isPassDue(await readIdlePassState(runtime.files, kit.paths), now)) {
        return;
    }
    const { files } = runtime;
    const lock = fileLockOf(runtime, kit.paths.idlePassLock, { ...config.lock, waitMs: 0 });
    try {
        await lock.run(async () => {
            const previous = await readIdlePassState(runtime.files, kit.paths);
            if (isPassDue(previous, now)) {
                await files.write(kit.paths.idlePass, formatIdlePassState(await passOnce(runtime, kit, config, roster, from, previous, now)));
            }
        });
    }
    catch (error) {
        // Another tab's check runs the pass now.
        if (!(error instanceof LockBusyError)) {
            throw error;
        }
    }
}
