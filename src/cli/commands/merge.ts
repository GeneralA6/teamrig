import { snapshotDirOf } from '../../budget/snapshot.ts';
import { LeadTree } from '../../config/lead-tree.ts';
import { coordinatorPlaces, teamPlace } from '../../coordinator/places.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { mergeBranch } from '../../merge/merge.ts';
import { ReviewHolds } from '../../merge/review-holds.ts';
import { JsonlEventLog } from '../../register/store.ts';
import type { ParsedArgs } from '../args.ts';
import { hostLockOf, logLineOf, nextResetFrom } from '../coordinator-ports.ts';
import { callerOf } from '../inputs.ts';
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { stoppableHooks, stoppableLock, stoppableSleep, stoppableSteps, stoppedWhileWaiting, unlessStopped, watchStarters } from '../stoppable.ts';

/**
 * `teamrig merge [--keep-remote] [--no-delete-local]`: merges the branch checked out in the current folder into origin's
 * default branch (src/merge/merge.ts). Refused for a branch it must not merge, from
 * `coordinator.schedule.heavyCutoffUtc` to midnight UTC and in the `resetBlackoutHours` before the weekly token reset;
 * it waits up to `coordinator.wait.maxMinutes` for quiet claims on what the push deploys and for the host lock, then
 * rebases, runs the repo's dependency check and review gate, and pushes, each a heavy step in the ledger. Once the
 * shell that started it ends, it stops waiting, or kills the step it runs (exit 129) and frees the lock. A repository
 * with a merge command runs it in place of the push. Exit 0 merged, 1 failed or stopped, 2 refused, 75 the merge
 * command waits: run it again once the branch is merged.
 */
export async function merge(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
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
    const end = await unlessStopped(
      stop,
      mergeBranch(
        {
          coordinator,
          places,
          zone,
          inTeam: (path) => teamPlace(kit.paths, path),
          review: { reviewPaths: config.pushGuard.reviewPaths, tree: new LeadTree(config), roles: config.roles },
        },
        {
          git: runtime.mergeGit,
          steps: stoppableSteps(runtime.steps, stop),
          hooks: stoppableHooks(runtime.hooks, stop),
          scanner: new SecretScanner(config.register.secretPatterns),
          files: runtime.files,
          reviewHolds: new ReviewHolds(runtime.files, places.reviewHolds),
          taskOf: async (id) => (await new JsonlEventLog(runtime.files, kit.paths.events).read()).state.tasks.get(id),
          clock: runtime.clock,
          sleep: stoppableSleep(runtime.sleep, stop),
          lock: stoppableLock(hostLockOf(runtime, places.hostLock, coordinator.heavy), stop),
          env: runtime.env,
          platform: runtime.platform,
          nextReset: nextResetFrom(runtime, budget, snapshotDirOf(budget, kit.paths)),
          newId: () => runtime.newId(),
          say,
        },
        { session, dir: runtime.cwd, keepRemote: args.switches.has('keep-remote'), keepLocal: args.switches.has('no-delete-local') },
      ),
    );
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
  } finally {
    watching.close();
  }
}
