import { resolveReset } from '../../budget/pace.ts';
import { readSnapshots, weekUseOf } from '../../budget/snapshot.ts';
import type { BudgetConfig } from '../../config/types.ts';
import { coordinatorPlaces, teamPlace } from '../../coordinator/places.ts';
import type { ResetTime } from '../../coordinator/schedule.ts';
import { integrateBranch } from '../../integrate/integrate.ts';
import type { ParsedArgs } from '../args.ts';
import { hostLockOf, logLine } from '../coordinator-ports.ts';
import { callerOf } from '../inputs.ts';
import { openTeamKit, requireConfig, rosterOf, sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { snapshotDirOf } from './budget.ts';

/** The next weekly token reset at each check: the one the status line last reported, else the one `budget.reset` sets; undefined when neither says. */
function nextResetFrom(runtime: CliRuntime, budget: Pick<BudgetConfig, 'reset'>, snapshotDir: string): (nowMs: number) => Promise<ResetTime | undefined> {
  return async (nowMs) => {
    const fromStatus = weekUseOf(await readSnapshots(runtime.files, snapshotDir), nowMs)?.resetsAt;
    const at = resolveReset(nowMs, fromStatus, budget.reset);
    if (at === undefined) {
      return undefined;
    }
    return { at, source: at === fromStatus ? 'status line' : 'budget.reset config' };
  };
}

/**
 * `teamrig integrate [--keep-remote] [--no-delete-local]`: lands the branch checked out in the current folder on origin's
 * default branch (src/integrate/integrate.ts). Refused for a branch it must not land, from
 * `coordinator.schedule.heavyCutoffUtc` to midnight UTC and in the `resetBlackoutHours` before the weekly token reset;
 * it waits up to `coordinator.wait.maxMinutes` for quiet claims on what the push deploys and for the host lock, then
 * rebases and pushes, the push a heavy step in the ledger. Exit 0 landed, 1 failed, 2 refused.
 */
export async function integrate(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const caller = callerOf(args.flags, runtime.env);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const session = sessionIdOf(await rosterOf(runtime, kit, config), caller);
  const { coordinator, budget } = config;
  const places = coordinatorPlaces(coordinator, kit.paths);
  const end = await integrateBranch(
    { coordinator, places, inTeam: (path) => teamPlace(kit.paths, path) },
    {
      git: runtime.integrateGit,
      steps: runtime.steps,
      files: runtime.files,
      clock: runtime.clock,
      sleep: runtime.sleep,
      lock: hostLockOf(runtime, places.hostLock, coordinator.heavy),
      env: runtime.env,
      platform: runtime.platform,
      nextReset: nextResetFrom(runtime, budget, snapshotDirOf(budget, kit.paths)),
      newId: () => runtime.newId(),
      say: (text) => logLine(runtime, text),
    },
    { session, dir: runtime.cwd, keepRemote: args.switches.has('keep-remote'), keepLocal: args.switches.has('no-delete-local') },
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
