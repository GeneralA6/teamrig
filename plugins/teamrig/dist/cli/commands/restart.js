import { launchOf } from "../../config/launch.js";
import { autoRestartOf } from "../../config/refresh.js";
import { errorMessage } from "../../core/guards.js";
import { KIT_NAME } from "../../core/home.js";
import { SecretScanner } from "../../core/secrets.js";
import { postLine } from "../../inbox/inbox.js";
import { refreshPrompt } from "../../open/prompt.js";
import { ClearAsks, clearAskDir } from "../../refresh/clear-asks.js";
import { personHoldOf, runRestart } from "../../refresh/restart.js";
import { RestartLog } from "../../refresh/restart-log.js";
import { RefreshStore } from "../../refresh/store.js";
import { RestoreRegistry, restoreSessionsDir } from "../../restore/registry.js";
import { onePositional, requiredFlag, UsageError } from "../args.js";
import { openKit, reloadTeamConfig, requireConfig, rosterOf } from "../kit.js";
import { EXIT } from "../runtime.js";
import { inboxDepsOf } from "./inbox.js";
import { idFlag, openSessionTab } from "./open.js";
/** What the session must know about its restart, as an inbox line: why none happened, or what failed after it. */
function inboxLineOf(result) {
    switch (result.kind) {
        case 'cancelled':
        case 'cleared':
            return undefined;
        case 'failed':
            return `the automatic restart did not happen: ${result.why}; type /clear for a fresh start`;
        case 'restarted':
            switch (result.endCommand?.kind) {
                case undefined:
                case 'done':
                    return undefined;
                case 'missing':
                    return 'you were restarted, but refresh.endCommand was not found, so the hooks a hard end skips did not run';
                case 'failed':
                    return `you were restarted, but refresh.endCommand failed (${result.endCommand.error}), so the hooks a hard end skips did not run`;
            }
    }
}
function resultLineOf(result, name) {
    switch (result.kind) {
        case 'cancelled':
            return `CANCELLED the restart of ${name}: ${result.why}`;
        case 'failed':
            return `FAILED the restart of ${name}: ${result.why}`;
        case 'cleared':
            return `CLEARED ${name}: its tab ran /clear`;
        case 'restarted':
            return `RESTARTED ${name} in ${result.where === 'same tab' ? 'the same tab' : 'a new tab'}`;
    }
}
/**
 * `restart <id> --team <team> --at <time> --project <dir>`: the automatic context refresh's restart,
 * which the Stop hook starts hidden once the session's handover is written (`runRestart`): the tab's mod
 * runs /clear when it claims the ask in time, else the session's process is ended. A new tab,
 * when one is needed, opens in the project folder the way `open`'s does. What the session must know
 * goes to its inbox, which it reads at its next prompt or start; every outcome goes to the restart
 * log (`RestartLog`); exit 1 when no restart happened.
 */
export async function restart(args, runtime) {
    const id = idFlag('session', onePositional(args, 'id'));
    const team = idFlag('--team', requiredFlag(args.flags, 'team'));
    const at = requiredFlag(args.flags, 'at');
    if (Number.isNaN(Date.parse(at))) {
        throw new UsageError(`--at "${at}" is not a time`);
    }
    const project = requiredFlag(args.flags, 'project');
    const kit = await openKit(runtime, team);
    const config = requireConfig(kit, runtime, 'read');
    const roster = await rosterOf(runtime, kit, config);
    const name = roster.nameOf(id) ?? id;
    const store = new RefreshStore(runtime.files, kit.paths);
    const log = new RestartLog(runtime.files, kit.paths);
    if (!config.refresh.enabled || !autoRestartOf(config, id)) {
        await store.clearRestart(id);
        const off = { kind: 'cancelled', why: 'the automatic restart is off (refresh.autoRestart in the team config)' };
        await logRestart(runtime, log, { session: id, at, endedAt: new Date(runtime.clock.now()).toISOString(), result: off });
        runtime.out.stdout(resultLineOf(off, name));
        return EXIT.ok;
    }
    const result = await runRestart({
        store,
        files: runtime.files,
        processes: runtime.sessionProcesses,
        clock: runtime.clock,
        sleep: runtime.sleep,
        platform: runtime.platform,
        asks: new ClearAsks(runtime.files, clearAskDir(kit.paths.kitHome)),
        restore: new RestoreRegistry(runtime.files, restoreSessionsDir(kit.paths.kitHome)),
        openTab: async () => {
            const tab = { team, id, name, project, prompt: refreshPrompt(team, id, store.handoverPath(id)), terminal: config.open.terminal, teamWindow: config.open.teamWindow };
            const { outcome } = await openSessionTab(runtime, tab);
            return outcome.kind === 'opened' ? { kind: 'opened' } : outcome;
        },
        launchEffort: async () => {
            // Read afresh: a typed /effort writes its level back to the config while the restart waits.
            const load = await reloadTeamConfig(runtime, kit);
            return load.status === 'loaded' ? launchOf(load.config, id).effort : undefined;
        },
    }, { team, id, at, delayMs: config.refresh.restartDelaySeconds * 1000, endCommand: config.refresh.endCommand, fallbackCwd: project, hold: personHoldOf(config.refresh) });
    const line = inboxLineOf(result);
    if (line !== undefined) {
        const secrets = new SecretScanner(config.register.secretPatterns);
        const problem = await postLine(inboxDepsOf(runtime, kit.paths).inboxes, secrets, { to: id, from: KIT_NAME, text: line, now: new Date(runtime.clock.now()) });
        if (problem !== undefined) {
            runtime.out.stderr(`WARN the inbox line to ${name} was not written: ${problem}`);
        }
    }
    await logRestart(runtime, log, { session: id, at, endedAt: new Date(runtime.clock.now()).toISOString(), result });
    runtime.out.stdout(resultLineOf(result, name));
    return result.kind === 'failed' ? EXIT.failed : EXIT.ok;
}
/** A log it cannot write is said, but is no reason to fail a restart that already happened. */
async function logRestart(runtime, log, entry) {
    try {
        await log.record(entry);
    }
    catch (error) {
        runtime.out.stderr(`WARN the restart log was not written: ${errorMessage(error)}`);
    }
}
