import { join } from 'node:path';
import { ENV } from '../core/home.ts';
import { formatUtcDay } from '../core/time.ts';
import { dayStartAt } from '../wake/day-start.ts';
import type { Kit } from './kit.ts';
import type { CliRuntime } from './runtime.ts';

/**
 * The team's daily `budget rollup --apply`, started from the day start's wake check. The rollup reads every transcript,
 * so it runs hidden and outside the hook, through `teamrig queue --small` for the cutoff and the host's memory. Every
 * tab's check comes here (a restore of many tabs at once too), so one atomic marker a day picks the one that starts it.
 */

/** Where each applied run adds its counts, since a hidden program's output goes nowhere. */
export function rollupRunLogOf(kit: Pick<Kit, 'paths'>): string {
  return join(kit.paths.rollup, 'runs.log');
}

/** Adds a line to the team's rollup run log. */
export function logRollupRun(runtime: Pick<CliRuntime, 'files'>, kit: Pick<Kit, 'paths'>, now: number, text: string): Promise<void> {
  return runtime.files.append(rollupRunLogOf(kit), `${new Date(now).toISOString()} ${text}\n`);
}

/**
 * Starts the rollup once for the day start `now` falls in. The marker takes another extension than a day's file, so the
 * day's readers skip it. A failed start is logged and not tried again: the next day's run reads on from the newest day
 * on disk, so it catches this one up.
 */
export async function startDailyRollup(
  runtime: Pick<CliRuntime, 'files' | 'processes' | 'self' | 'cwd' | 'env'>,
  kit: Pick<Kit, 'paths'>,
  session: string,
  dayStartUtc: string,
  now: number,
): Promise<void> {
  const dayStart = dayStartAt(dayStartUtc, now);
  if (dayStart === undefined) {
    return;
  }
  const marker = join(kit.paths.rollup, `${formatUtcDay(new Date(dayStart))}.started`);
  // Read first: every wake check of every tab comes here, and a create writes a file each time, even when it loses.
  if ((await runtime.files.read(marker)) !== undefined || !(await runtime.files.createExclusive(marker, `${session}\n`))) {
    return;
  }
  const { node, script } = runtime.self;
  const started = await runtime.processes.startHidden({
    command: node,
    args: [script, 'queue', '--what', 'usage rollup', '--small', '--session', session, '--', node, script, 'budget', 'rollup', '--apply'],
    cwd: runtime.cwd,
    env: { ...runtime.env, [ENV.team]: kit.paths.team },
  });
  if (started.kind !== 'started') {
    await logRollupRun(runtime, kit, now, `FAILED to start: ${started.kind === 'missing' ? 'node was not found' : started.error}`);
  }
}
