import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { errorMessage } from '../../core/guards.ts';
import { FileLock, LockBusyError } from '../../core/lock.ts';
import type { StartOutcome } from '../../open/processes.ts';
import { idlePassOf, passLineOf, type PassStep, type SessionFolderOf } from '../idle-pass.ts';
import { readIdlePassState } from '../idle-pass-check.ts';
import {
  actsToStart,
  changedSteps,
  failedState,
  formatIdlePassRecord,
  formatIdlePassState,
  heldActs,
  isPassDue,
  passedState,
  type ActToStart,
  type IdleAct,
  type IdlePassRecord,
  type IdlePassState,
  type PendingAct,
} from '../idle-pass-log.ts';
import { teamZone, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { sessionFoldersOf } from './setup.ts';

/** The pass's steps and each session's folder it read them in, or the error it failed with. */
type PassRun = { readonly kind: 'ran'; readonly steps: readonly PassStep[]; readonly folderOf: SessionFolderOf } | { readonly kind: 'failed'; readonly error: string };

/**
 * Runs the pass, each session in its own project folder as `teamrig sessions --pass` does by default. The pass reads
 * the host's processes and every session's record, transcript and budget; a failure there is the pass's, logged as
 * such, and must not cost the tab its wake answer.
 */
async function runPass(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, from: string): Promise<PassRun> {
  try {
    const folderOf = sessionFoldersOf(runtime, config, undefined, from);
    return { kind: 'ran', steps: await idlePassOf(runtime, kit, config, roster, folderOf), folderOf };
  } catch (error) {
    return { kind: 'failed', error: errorMessage(error) };
  }
}

/** The internal command that makes each act (idle-act.ts). */
const ACT_COMMANDS: Readonly<Record<IdleAct, string>> = { close: 'idle-close', reopen: 'idle-open' };

function startProblemOf(started: Exclude<StartOutcome, { readonly kind: 'started' }>): string {
  return started.kind === 'missing' ? 'node was not found' : started.error;
}

/** Starts one act hidden in its session's own folder; why it did not start, undefined when it did. */
async function startAct(runtime: CliRuntime, kit: Kit, folderOf: SessionFolderOf, { act, id }: ActToStart): Promise<string | undefined> {
  let project: string;
  try {
    project = await folderOf(id);
  } catch (error) {
    return errorMessage(error);
  }
  const started = await runtime.processes.startHidden({
    command: runtime.self.node,
    args: [runtime.self.script, ACT_COMMANDS[act], id, '--team', kit.paths.team, '--project', project],
    cwd: project,
    env: runtime.env,
  });
  return started.kind === 'started' ? undefined : startProblemOf(started);
}

/**
 * Starts each act hidden, as hook-restart.ts starts `teamrig restart`: a close takes up to about 22 s
 * (src/open/end-tab.ts) and the mod ends a wake check at 30 s (src/mod/wake-hand.ts), so none runs inside the check.
 * Each act weighs its session again and logs its own outcome. Each is marked pending, one that did not start too, so
 * the passes after it start none on its session for `IDLE_ACT_HOLD_MS`; one that did not start, its folder refused
 * too, is logged.
 */
async function startActs(runtime: CliRuntime, kit: Kit, roster: Roster, folderOf: SessionFolderOf, acts: readonly ActToStart[], now: number): Promise<Record<string, PendingAct>> {
  const pending: Record<string, PendingAct> = {};
  for (const toStart of acts) {
    const { act, id } = toStart;
    const problem = await startAct(runtime, kit, folderOf, toStart);
    pending[id] = { act, at: now };
    if (problem !== undefined) {
      const line = `FAILED to start the ${act} of ${roster.nameOf(id) ?? id} (session ${id}): ${problem}`;
      await runtime.files.append(kit.paths.idlePassLog, formatIdlePassRecord({ kind: 'act', at: now, mode: 'on', act, id, outcome: 'failed', line, before: undefined, after: undefined }));
    }
  }
  return pending;
}

/**
 * One pass, under its lock: logs the steps whose kind changed, or a new failure, with the host's commit charge; in
 * mode `on` starts each act its steps ask for and none pending; and keeps the state for the next pass.
 */
async function passOnce(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, from: string, previous: IdlePassState | undefined, now: number): Promise<IdlePassState> {
  const { mode } = config.open.idle;
  const { files } = runtime;
  const run = await runPass(runtime, kit, config, roster, from);
  if (run.kind === 'failed') {
    if (previous?.failed !== run.error) {
      await files.append(kit.paths.idlePassLog, formatIdlePassRecord({ kind: 'failed', at: now, mode, error: run.error }));
    }
    return failedState(previous, now, run.error);
  }
  const changed = changedSteps(previous, run.steps);
  if (changed.length > 0) {
    const zone = teamZone(config, runtime);
    const steps = changed.map((step) => ({ kind: step.kind, id: step.id, line: passLineOf(step, roster, zone) }));
    const record: IdlePassRecord = { kind: 'pass', at: now, mode, commit: await runtime.memory.commit(), steps };
    await files.append(kit.paths.idlePassLog, formatIdlePassRecord(record));
  }
  const held = heldActs(previous?.pending, run.steps, now);
  const started = mode === 'on' ? await startActs(runtime, kit, roster, run.folderOf, actsToStart(run.steps, held), now) : {};
  return passedState(now, run.steps, { ...held, ...started });
}

/**
 * The idle pass as `hook wake-check` runs it (T1100), unless `open.idle.mode` is off: once every `IDLE_PASS_EVERY_MS`
 * across the team, claimed under a lock no check waits for, it works out what `teamrig sessions --pass` prints and
 * appends to the team's pass log the steps whose kind changed since the last pass, with the host's commit charge;
 * a failed pass logs its error once until the error changes. In dry-run it changes nothing else; in `on` it starts
 * the closes and the reopen its steps ask for. With mode off it reads nothing.
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
      if (isPassDue(previous, now)) {
        await files.write(kit.paths.idlePass, formatIdlePassState(await passOnce(runtime, kit, config, roster, from, previous, now)));
      }
    });
  } catch (error) {
    // Another tab's check runs the pass now.
    if (!(error instanceof LockBusyError)) {
      throw error;
    }
  }
}
