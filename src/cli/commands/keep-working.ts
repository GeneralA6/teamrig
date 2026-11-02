import { errorMessage } from '../../core/guards.ts';
import type { TeamPaths } from '../../core/home.ts';
import { SessionAskStore } from '../../core/session-asks.ts';
import type { WriteResult } from '../../register/register.ts';
import { WARM_WAKE_W, wakeRestOf } from '../../wake/decide.ts';
import { keepWorkingOf, keepWorkingReason } from '../../wake/keep-working.ts';
import { teamZone } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { teamRegister } from '../team-register.ts';
import { budgetFactsOf, type BudgetScope } from './hook-budget.ts';

/**
 * The keep-working ask (wake/keep-working.ts) on the command line: `set` records it when a task goes waiting, and
 * the owner's Stop hook turns it into a one-time block that sends the session to its work it can start.
 */

/** After a `set` to waiting: records the ask for the task's owner. The task is already waiting, so a failure here only warns and the exit stays 0. */
export async function markKeepWorkingAsk(runtime: CliRuntime, paths: TeamPaths, written: WriteResult): Promise<void> {
  const { task } = written;
  try {
    await new SessionAskStore(runtime.files, paths.keepWorkingAsks).set(task.owner, { task: task.id, at: new Date(runtime.clock.now()).toISOString() });
  } catch (error) {
    runtime.out.stderr(`WARN ${task.id} is waiting, but the ask for ${task.owner} to keep working was not recorded: ${errorMessage(error)}`);
  }
}

/**
 * The Stop hook's block reason for the session from its due ask; undefined without one, in the budget's quiet hours
 * or while its budget holds or a short day pauses it (the day-start wake brings it back to its work), or with nothing
 * it can start. The ask is
 * removed before the reason is returned, so it blocks one stop only. Most stops read one missing file; the budget
 * and the register are read only when an ask is due.
 */
export async function keepWorkingReasonOf(runtime: CliRuntime, scope: BudgetScope): Promise<string | undefined> {
  const { kit, config, id } = scope;
  const store = new SessionAskStore(runtime.files, kit.paths.keepWorkingAsks);
  const ask = await store.get(id);
  if (ask === undefined) {
    return undefined;
  }
  await store.clear(id);
  const now = runtime.clock.now();
  // The blocked stop goes on at once, so its next call reads the warm cache.
  const rest = wakeRestOf(await budgetFactsOf(runtime, scope, undefined), config.budget.quietHours, now, WARM_WAKE_W);
  const { snapshot, elsewhere } = await teamRegister(runtime, kit.paths, config).snapshotWithElsewhere();
  const zone = teamZone(config, runtime);
  const work = keepWorkingOf({ tasks: snapshot.state.tasks, elsewhere, session: id, ask, now, zone, rest });
  return work === undefined ? undefined : keepWorkingReason(id, work, zone);
}
