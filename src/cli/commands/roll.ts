import { coordinatorPlaces, teamPlace } from '../../coordinator/places.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { rollRepo } from '../../roll/roll.ts';
import type { ParsedArgs } from '../args.ts';
import { hostLockOf, logLine, nextResetFrom } from '../coordinator-ports.ts';
import { callerOf } from '../inputs.ts';
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { snapshotDirOf } from './budget.ts';

/**
 * `teamrig roll [--repo <name>]`: brings what was pushed to a repository's default branch to the running system
 * (src/roll/roll.ts): pulls its main checkout fast-forward and runs `coordinator.repos.<name>.roll`, its afterPull
 * hooks then its command, one heavy step in the ledger, and records the deploy. Refused for a main checkout it must not
 * pull into, from `coordinator.schedule.heavyCutoffUtc` to midnight UTC, in the `resetBlackoutHours` before the weekly
 * token reset and when a gate refuses; it waits up to `coordinator.wait.maxMinutes` for quiet claims on its targets,
 * its gates and the host lock. Exit 0 rolled or nothing pending, 1 failed, 2 refused.
 */
export async function roll(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const caller = callerOf(args.flags, runtime.env);
  const { team } = await findTeam(runtime);
  const kit = await openKit(runtime, team);
  const config = requireConfig(kit, runtime, 'read');
  const session = sessionIdOf(await rosterOf(runtime, kit, config), caller);
  const { coordinator, budget } = config;
  const places = coordinatorPlaces(coordinator, kit.paths);
  const end = await rollRepo(
    { team, coordinator, places, inTeam: (path) => teamPlace(kit.paths, path) },
    {
      git: runtime.integrateGit,
      hooks: runtime.hooks,
      files: runtime.files,
      clock: runtime.clock,
      sleep: runtime.sleep,
      lock: hostLockOf(runtime, places.hostLock, coordinator.heavy),
      env: runtime.env,
      platform: runtime.platform,
      scanner: new SecretScanner(config.register.secretPatterns),
      nextReset: nextResetFrom(runtime, budget, snapshotDirOf(budget, kit.paths)),
      newId: () => runtime.newId(),
      say: (text) => logLine(runtime, text),
    },
    { session, repo: args.flags.get('repo'), dir: runtime.cwd },
  );
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
