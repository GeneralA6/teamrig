import { snapshotDirOf } from "../../budget/snapshot.js";
import { deliveryPlaces, teamPlace } from "../../delivery/places.js";
import { SecretScanner } from "../../core/secrets.js";
import { redeployTargets } from "../../deploy/deploy.js";
import { deployRepo } from "../../deploy/run.js";
import { requiredFlag, UsageError } from "../args.js";
import { hostLockOf, logLineOf, nextResetFrom } from "../delivery-ports.js";
import { callerOf, commandWordsOf, listOf } from "../inputs.js";
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf, teamZone } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { stoppableHooks, stoppableLock, stoppableSleep, stoppedWhileWaiting, unlessStopped, watchStarters } from "../stoppable.js";
/** The deploy `--targets` asks for, with its `--what` and the command after `--`; undefined for a plain deploy. */
function redeployPartsOf(args) {
    const targets = args.flags.get('targets');
    if (targets === undefined) {
        if (args.flags.has('what') || args.rest.length > 0) {
            throw new UsageError('--what and a command after -- make a deploy: name the targets it restarts with --targets <a,b>');
        }
        return undefined;
    }
    return { targets: listOf('--targets', targets), why: requiredFlag(args.flags, 'what'), argv: commandWordsOf(args) };
}
/**
 * `teamrig deploy [--repo <name>]`: brings what was pushed to a repository's default branch to the running system
 * (src/deploy/run.ts): pulls its main checkout fast-forward and runs `delivery.repos.<name>.deploy`, its afterPull
 * hooks then its command, one queued step in the ledger, and records the deploy. With `--targets <a,b> --what "<why>"
 * -- <command>` it pulls nothing and runs that command instead, a deploy of those targets (src/deploy/deploy.ts). Refused
 * for a main checkout it must not pull into, from `delivery.schedule.queueCutoffUtc` to midnight UTC, in the
 * `resetBlackoutHours` before the weekly token reset and when a check refuses; it waits up to
 * `delivery.wait.maxMinutes` for deploy freezes on its targets, its checks and the host lock. Once the shell that
 * started it ends, it stops waiting, or kills the hook it runs (exit 129) and frees the lock. Exit 0 deployed or nothing
 * pending, 1 failed or stopped, 2 refused.
 */
export async function deploy(args, runtime) {
    const redeploy = redeployPartsOf(args);
    const caller = callerOf(args.flags, runtime.env);
    const { team } = await findTeam(runtime);
    const kit = await openKit(runtime, team);
    const config = requireConfig(kit, runtime, 'read');
    const zone = teamZone(config, runtime);
    const session = sessionIdOf(await rosterOf(runtime, kit, config), caller);
    const { delivery, budget } = config;
    const places = deliveryPlaces(delivery, kit.paths);
    const say = logLineOf(runtime, zone);
    const watching = await watchStarters(runtime, say);
    try {
        const { stop } = watching;
        const setup = { team, delivery, places, zone, inTeam: (path) => teamPlace(kit.paths, path), focus: config.focus };
        const ports = {
            git: runtime.mergeGit,
            hooks: stoppableHooks(runtime.hooks, stop),
            files: runtime.files,
            memory: runtime.memory,
            pid: runtime.pid,
            clock: runtime.clock,
            sleep: stoppableSleep(runtime.sleep, stop),
            lock: stoppableLock(hostLockOf(runtime, places.hostLock, delivery.queue, config.open.headroom, config.focus, zone), stop),
            env: runtime.env,
            platform: runtime.platform,
            scanner: new SecretScanner(config.register.secretPatterns),
            nextReset: nextResetFrom(runtime, budget, snapshotDirOf(budget, kit.paths)),
            newId: () => runtime.newId(),
            say,
        };
        const request = { session, repo: args.flags.get('repo'), dir: runtime.cwd };
        const end = await unlessStopped(stop, redeploy === undefined ? deployRepo(setup, ports, request) : redeployTargets(setup, ports, { ...request, ...redeploy }));
        if (end === undefined) {
            return stoppedWhileWaiting(runtime, say, watching);
        }
        switch (end.kind) {
            case 'done':
                runtime.out.stdout(`DONE ${end.summary}`);
                return EXIT.ok;
            case 'failed':
                runtime.out.stdout(`FAILED ${end.reason}`);
                return EXIT.failed;
            case 'refused':
                throw new RefusedError(end.reason);
        }
    }
    finally {
        watching.close();
    }
}
