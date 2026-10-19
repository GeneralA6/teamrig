import { coordinatorPlaces, teamPlace } from '../../coordinator/places.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { rollRepo } from '../../roll/roll.ts';
import type { ParsedArgs } from '../args.ts';
import { hostLockOf, logLineOf, nextResetFrom } from '../coordinator-ports.ts';
import { callerOf } from '../inputs.ts';
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf, teamZone } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { stoppableHooks, stoppableLock, stoppableSleep, stoppedWhileWaiting, unlessStopped, watchStarters } from '../stoppable.ts';
import { snapshotDirOf } from './budget.ts';

/**
 * `teamrig roll [--repo <name>]`: brings what was pushed to a repository's default branch to the running system
 * (src/roll/roll.ts): pulls its main checkout fast-forward and runs `coordinator.repos.<name>.roll`, its afterPull
 * hooks then its command, one heavy step in the ledger, and records the deploy. Refused for a main checkout it must not
 * pull into, from `coordinator.schedule.heavyCutoffUtc` to midnight UTC, in the `resetBlackoutHours` before the weekly
 * token reset and when a gate refuses; it waits up to `coordinator.wait.maxMinutes` for quiet claims on its targets,
 * its gates and the host lock. Once the shell that started it ends, it stops waiting, or kills the hook it runs (exit
 * 129) and frees the lock. Exit 0 rolled or nothing pending, 1 failed or stopped, 2 refused.
 */
export async function roll(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const caller = callerOf(args.flags, runtime.env);
  const { team } = await findTeam(runtime);
  const kit = await openKit(runtime, team);
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
      rollRepo(
        { team, coordinator, places, zone, inTeam: (path) => teamPlace(kit.paths, path) },
        {
          git: runtime.integrateGit,
          hooks: stoppableHooks(runtime.hooks, stop),
          files: runtime.files,
          clock: runtime.clock,
          sleep: stoppableSleep(runtime.sleep, stop),
          lock: stoppableLock(hostLockOf(runtime, places.hostLock, coordinator.heavy), stop),
          env: runtime.env,
          platform: runtime.platform,
          scanner: new SecretScanner(config.register.secretPatterns),
          nextReset: nextResetFrom(runtime, budget, snapshotDirOf(budget, kit.paths)),
          newId: () => runtime.newId(),
          say,
        },
        { session, repo: args.flags.get('repo'), dir: runtime.cwd },
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
