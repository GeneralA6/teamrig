import { coordinatorPlaces, teamPlace } from '../../coordinator/places.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { integrateBranch } from '../../integrate/integrate.ts';
import type { ParsedArgs } from '../args.ts';
import { hostLockOf, logLineOf, nextResetFrom } from '../coordinator-ports.ts';
import { callerOf } from '../inputs.ts';
import { openTeamKit, requireConfig, rosterOf, sessionIdOf, teamZone } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { stoppableHooks, stoppableLock, stoppableSleep, stoppableSteps, stoppedWhileWaiting, unlessStopped, watchStarters } from '../stoppable.ts';
import { snapshotDirOf } from './budget.ts';

/**
 * `teamrig integrate [--keep-remote] [--no-delete-local]`: lands the branch checked out in the current folder on origin's
 * default branch (src/integrate/integrate.ts). Refused for a branch it must not land, from
 * `coordinator.schedule.heavyCutoffUtc` to midnight UTC and in the `resetBlackoutHours` before the weekly token reset;
 * it waits up to `coordinator.wait.maxMinutes` for quiet claims on what the push deploys and for the host lock, then
 * rebases and pushes, the push a heavy step in the ledger. Once the shell that started it ends, it stops waiting, or
 * kills the step it runs (exit 129) and frees the lock. Exit 0 landed, 1 failed or stopped, 2 refused.
 */
export async function integrate(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
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
      integrateBranch(
        { coordinator, places, zone, inTeam: (path) => teamPlace(kit.paths, path) },
        {
          git: runtime.integrateGit,
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
    }
  } finally {
    watching.close();
  }
}
