import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { errorMessage } from '../../core/guards.ts';
import { FileLock, LockBusyError } from '../../core/lock.ts';
import { idlePassOf, passLineOf, type PassStep } from '../idle-pass.ts';
import { readIdlePassState } from '../idle-pass-check.ts';
import { changedSteps, failedState, formatIdlePassRecord, formatIdlePassState, isPassDue, passedState, type IdlePassRecord, type IdlePassState } from '../idle-pass-log.ts';
import { teamZone, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { sessionFoldersOf } from './setup.ts';

/** What one pass leaves: the state to keep, and the record to log (undefined: nothing new). */
interface PassOutcome {
  readonly state: IdlePassState;
  readonly record: IdlePassRecord | undefined;
}

/** The pass's steps, or the error it failed with. */
type PassRun = { readonly kind: 'ran'; readonly steps: readonly PassStep[] } | { readonly kind: 'failed'; readonly error: string };

/**
 * Runs the pass, each session in its own project folder as `teamrig sessions --pass` does by default. The pass reads
 * the host's processes and every session's record, transcript and budget; a failure there is the pass's, logged as
 * such, and must not cost the tab its wake answer.
 */
async function runPass(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, from: string): Promise<PassRun> {
  try {
    return { kind: 'ran', steps: await idlePassOf(runtime, kit, config, roster, sessionFoldersOf(runtime, config, undefined, from)) };
  } catch (error) {
    return { kind: 'failed', error: errorMessage(error) };
  }
}

async function outcomeOf(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, from: string, previous: IdlePassState | undefined, now: number): Promise<PassOutcome> {
  const { mode } = config.open.idle;
  const run = await runPass(runtime, kit, config, roster, from);
  if (run.kind === 'failed') {
    const record: IdlePassRecord | undefined = previous?.failed === run.error ? undefined : { kind: 'failed', at: now, mode, error: run.error };
    return { state: failedState(previous, now, run.error), record };
  }
  const changed = changedSteps(previous, run.steps);
  if (changed.length === 0) {
    return { state: passedState(now, run.steps), record: undefined };
  }
  const zone = teamZone(config, runtime);
  const steps = changed.map((step) => ({ kind: step.kind, id: step.id, line: passLineOf(step, roster, zone) }));
  return { state: passedState(now, run.steps), record: { kind: 'pass', at: now, mode, commit: await runtime.memory.commit(), steps } };
}

/**
 * The idle pass as `hook wake-check` runs it (T1100), unless `open.idle.mode` is off: once every `IDLE_PASS_EVERY_MS`
 * across the team, claimed under a lock no check waits for, it works out what `teamrig sessions --pass` prints and
 * appends to the team's pass log the steps whose kind changed since the last pass, with the host's commit charge;
 * a failed pass logs its error once until the error changes. In dry-run it changes nothing else. With mode off it
 * reads nothing.
 */
export async function runIdlePass(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, from: string): Promise<void> {
  if (config.open.idle.mode === 'off') {
    return;
  }
  const now = runtime.clock.now();
  if (!isPassDue(await readIdlePassState(runtime.files, kit.paths), now)) {
    return;
  }
  const { files, clock, sleep, pid } = runtime;
  const lock = new FileLock(kit.paths.idlePassLock, { ...config.lock, waitMs: 0 }, { files, clock, sleep, pid });
  try {
    await lock.run(async () => {
      const previous = await readIdlePassState(runtime.files, kit.paths);
      if (!isPassDue(previous, now)) {
        return;
      }
      const { state, record } = await outcomeOf(runtime, kit, config, roster, from, previous, now);
      if (record !== undefined) {
        await files.append(kit.paths.idlePassLog, formatIdlePassRecord(record));
      }
      await files.write(kit.paths.idlePass, formatIdlePassState(state));
    });
  } catch (error) {
    // Another tab's check runs the pass now.
    if (!(error instanceof LockBusyError)) {
      throw error;
    }
  }
}
