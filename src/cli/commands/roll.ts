import { snapshotDirOf } from '../../budget/snapshot.ts';
import { coordinatorPlaces, teamPlace } from '../../coordinator/places.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { deployTargets } from '../../roll/deploy.ts';
import { rollRepo, type RollRequest } from '../../roll/roll.ts';
import { requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { hostLockOf, logLineOf, nextResetFrom } from '../coordinator-ports.ts';
import { callerOf, commandWordsOf, listOf } from '../inputs.ts';
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf, teamZone } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { stoppableHooks, stoppableLock, stoppableSleep, stoppedWhileWaiting, unlessStopped, watchStarters } from '../stoppable.ts';

/** What a deploy that pulls nothing restarts, why, and the command that does it. */
interface DeployParts {
  readonly targets: readonly string[];
  readonly why: string;
  readonly argv: readonly string[];
}

/** The deploy `--targets` asks for, with its `--what` and the command after `--`; undefined for a plain roll. */
function deployPartsOf(args: ParsedArgs): DeployParts | undefined {
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
 * `teamrig roll [--repo <name>]`: brings what was pushed to a repository's default branch to the running system
 * (src/roll/roll.ts): pulls its main checkout fast-forward and runs `coordinator.repos.<name>.roll`, its afterPull
 * hooks then its command, one heavy step in the ledger, and records the deploy. With `--targets <a,b> --what "<why>"
 * -- <command>` it pulls nothing and runs that command instead, a deploy of those targets (src/roll/deploy.ts). Refused
 * for a main checkout it must not pull into, from `coordinator.schedule.heavyCutoffUtc` to midnight UTC, in the
 * `resetBlackoutHours` before the weekly token reset and when a gate refuses; it waits up to
 * `coordinator.wait.maxMinutes` for quiet claims on its targets, its gates and the host lock. Once the shell that
 * started it ends, it stops waiting, or kills the hook it runs (exit 129) and frees the lock. Exit 0 rolled or nothing
 * pending, 1 failed or stopped, 2 refused.
 */
export async function roll(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const deploy = deployPartsOf(args);
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
    const setup = { team, coordinator, places, zone, inTeam: (path: string) => teamPlace(kit.paths, path) };
    const ports = {
      git: runtime.mergeGit,
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
    };
    const request: RollRequest = { session, repo: args.flags.get('repo'), dir: runtime.cwd };
    const end = await unlessStopped(stop, deploy === undefined ? rollRepo(setup, ports, request) : deployTargets(setup, ports, { ...request, ...deploy }));
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
