import { snapshotDirOf } from "../../budget/snapshot.js";
import { coordinatorPlaces, teamPlace } from "../../coordinator/places.js";
import { SecretScanner } from "../../core/secrets.js";
import { mergeBranch } from "../../merge/merge.js";
import { hostLockOf, logLineOf, nextResetFrom } from "../coordinator-ports.js";
import { callerOf } from "../inputs.js";
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { stoppableHooks, stoppableLock, stoppableSleep, stoppableSteps, stoppedWhileWaiting, unlessStopped, watchStarters } from "../stoppable.js";
/**
 * `teamrig merge [--keep-remote] [--no-delete-local]`: merges the branch checked out in the current folder into origin's
 * default branch (src/merge/merge.ts). Refused for a branch it must not merge, from
 * `coordinator.schedule.heavyCutoffUtc` to midnight UTC and in the `resetBlackoutHours` before the weekly token reset;
 * it waits up to `coordinator.wait.maxMinutes` for quiet claims on what the push deploys and for the host lock, then
 * rebases and pushes, the push a heavy step in the ledger. Once the shell that started it ends, it stops waiting, or
 * kills the step it runs (exit 129) and frees the lock. A repository with a merge command runs it in place of the push.
 * Exit 0 merged, 1 failed or stopped, 2 refused, 75 the merge command waits: run it again once the branch is merged.
 */
export async function merge(args, runtime) {
    const caller = callerOf(args.flags, runtime.env);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const zone = teamZone(config, runtime);
    const session = sessionIdOf(await rosterOf(runtime, kit, config), caller);
    const { coordinator, budget } = config;
    const places = coordinatorPlaces(coordinator, kit.paths);
    const say = logLineOf(runtime, zone);
    const watching = await watchStarters(runtime, say);
    try {
        const { stop } = watching;
        const end = await unlessStopped(stop, mergeBranch({ coordinator, places, zone, inTeam: (path) => teamPlace(kit.paths, path) }, {
            git: runtime.mergeGit,
            steps: stoppableSteps(runtime.steps, stop),
            hooks: stoppableHooks(runtime.hooks, stop),
            scanner: new SecretScanner(config.register.secretPatterns),
            files: runtime.files,
            clock: runtime.clock,
            sleep: stoppableSleep(runtime.sleep, stop),
            lock: stoppableLock(hostLockOf(runtime, places.hostLock, coordinator.heavy), stop),
            env: runtime.env,
            platform: runtime.platform,
            nextReset: nextResetFrom(runtime, budget, snapshotDirOf(budget, kit.paths)),
            newId: () => runtime.newId(),
            say,
        }, { session, dir: runtime.cwd, keepRemote: args.switches.has('keep-remote'), keepLocal: args.switches.has('no-delete-local') }));
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
            case 'waiting':
                runtime.out.stdout(`WAITING ${end.reason}`);
                return EXIT.waiting;
        }
    }
    finally {
        watching.close();
    }
}
