import type { Roster } from '../config/roster.ts';
import type { KitConfig } from '../config/types.ts';
import { errorMessage } from '../core/guards.ts';
import { KIT_NAME } from '../core/home.ts';
import { LockBusyError } from '../core/lock.ts';
import { fileLockOf } from './file-locks.ts';
import { readIdlePassState } from './idle-pass-check.ts';
import { formatIdlePassState, IDLE_ACT_HOLD_MS, IDLE_PASS_EVERY_MS, type IdlePassState } from './idle-pass-log.ts';
import { closedOf, SessionLog } from '../sessions/log.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import type { Kit } from './kit.ts';
import type { CliRuntime } from './runtime.ts';

/**
 * A wake for a session teamrig closed (#1581). A wake ask is taken by the session's own tab's wake check, and a closed
 * session has no tab: the idle pass reopens it for the ask, but only at a later pass, and the sender was told it
 * "WAKES … within about 3 minutes" though nothing ran. So once the ask is posted, a closed session's reopen starts at
 * once through the pass's own act (`idle-open`, src/cli/commands/idle-act.ts): it judges the session again as the pass
 * does, keeps it closed on an unsettled install or a host with no room, and logs its outcome in the pass log. Its
 * room is read here first, so the sender is told the truth: it reopens, or it stays closed and why.
 *
 * `open`: not closed by teamrig (running or never started): woken as before.
 */
export type ClosedWake =
  | { readonly kind: 'open' }
  /** `already`: a reopen another wake or the pass started is still pending, so none started now. */
  | { readonly kind: 'reopening'; readonly already?: boolean }
  | { readonly kind: 'closed'; readonly why: string };

/**
 * After a wake ask was posted for `id` on the team of `kit`: starts the reopen of a session teamrig closed, as one
 * pass would, or says why it stays closed. A reopen that cannot start is `closed` with why; it never throws.
 */
export async function wakeClosedSession(runtime: CliRuntime, kit: Pick<Kit, 'paths'>, config: KitConfig, roster: Roster, id: string): Promise<ClosedWake> {
  try {
    const closed = closedOf((await new SessionLog(runtime.files, kit.paths.sessionLog).read()).records, id);
    if (closed === undefined || !(await closedByTeamrig(runtime, kit, id))) {
      return { kind: 'open' };
    }
    const { mode } = config.open.idle;
    if (mode !== 'on') {
      return { kind: 'closed', why: `open.idle.mode is ${mode}, so the idle pass reopens nothing` };
    }
    const folder = closed.folder;
    if (folder === undefined) {
      return { kind: 'closed', why: 'its close names no folder to reopen it in; the idle pass reopens it' };
    }
    // Loaded only for a closed session: the pass's room check pulls in the pass and the hooks need neither.
    const { reopenHoldOf } = await import('./idle-pass.ts');
    const hold = await reopenHoldOf(runtime, kit, config, roster, folder, id);
    if (hold !== undefined) {
      return { kind: 'closed', why: hold };
    }
    return await startReopenOnce(runtime, kit, config, id, folder);
  } catch (error) {
    if (error instanceof LockBusyError) {
      return { kind: 'closed', why: 'the idle pass holds its lock now, and that pass or the next reopens it for the line' };
    }
    return { kind: 'closed', why: `its state could not be read (${errorMessage(error)})` };
  }
}

/**
 * Starts `idle-open` for `id` once: under the idle pass's lock it takes the pass's own pending mark for the session
 * (src/cli/idle-pass-log.ts `heldActs`), so two wakes close together, or a wake beside a pass, never open two tabs of
 * one session. A reopen already pending under `IDLE_ACT_HOLD_MS` starts none; the closed state is read again under
 * the lock, as a reopen that ran meanwhile leaves the session open.
 */
async function startReopenOnce(runtime: CliRuntime, kit: Pick<Kit, 'paths'>, config: KitConfig, id: string, folder: string): Promise<ClosedWake> {
  return fileLockOf(runtime, kit.paths.idlePassLock, config.lock).run(async () => {
    const now = runtime.clock.now();
    const state = await readIdlePassState(runtime.files, kit.paths);
    const mark = state?.pending?.[id];
    if (mark !== undefined && now >= mark.at && now - mark.at < IDLE_ACT_HOLD_MS) {
      // The pass marks its closes pending too, and takes no second act on a session while one is: a pending close is
      // no reopen under way, so it is said as it is.
      return mark.act === 'reopen' ? { kind: 'reopening', already: true } : { kind: 'closed', why: 'its close a moment ago is still settling' };
    }
    if (!(await closedByTeamrig(runtime, kit, id))) {
      return { kind: 'open' };
    }
    const started = await runtime.processes.startHidden({
      command: runtime.self.node,
      args: [runtime.self.script, 'idle-open', id, '--team', kit.paths.team, '--project', folder],
      cwd: folder,
      env: runtime.env,
    });
    if (started.kind !== 'started') {
      return { kind: 'closed', why: `its reopen did not start (${started.kind === 'missing' ? 'node was not found' : started.error})` };
    }
    // With no pass yet, the state starts a pass interval back, so the next check still runs one.
    const base: IdlePassState = state ?? { at: now - IDLE_PASS_EVERY_MS, kinds: {} };
    await runtime.files.write(kit.paths.idlePass, formatIdlePassState({ ...base, pending: { ...base.pending, [id]: { act: 'reopen', at: now } } }));
    return { kind: 'reopening' };
  });
}

/**
 * Whether teamrig closed `id`, so no tab of it takes a wake ask: its session log's newest record is a close, and no
 * tab of it was started by hand since (its session record is newer), as the closed-send hold reads it.
 */
export async function closedByTeamrig(runtime: CliRuntime, kit: Pick<Kit, 'paths'>, id: string): Promise<boolean> {
  try {
    const closed = closedOf((await new SessionLog(runtime.files, kit.paths.sessionLog).read()).records, id);
    if (closed === undefined) {
      return false;
    }
    const started = await new SessionRecordStore(runtime.files, kit.paths).read(id);
    return started === undefined || Date.parse(started.at) <= Date.parse(closed.at);
  } catch {
    return false;
  }
}

/** The line a timed wake (`--wake-by`) of a closed session gets: the line waits, and the idle pass reopens it once due. */
export function closedTimedWakeLine(label: string, id: string, clock: string): string {
  return `CLOSED: ${label} is closed, so this line waits: the idle pass reopens it for the line once it is due (${clock}) and the host has room, or run: ${KIT_NAME} open ${id}`;
}

/** The line a sender is shown for a closed session's wake, never WAKES; undefined for an open one. */
export function closedWakeLine(wake: ClosedWake, label: string, id: string): string | undefined {
  switch (wake.kind) {
    case 'open':
      return undefined;
    case 'reopening':
      return wake.already === true
        ? `REOPENS ${label}: it was closed, and its reopen started a moment ago is still under way, so none started for this line; it opens once the host has room, the idle pass log saying REOPENED or KEPT with why (or run: ${KIT_NAME} open ${id})`
        : `REOPENS ${label}: it was closed, and its reopen started now for this line; it opens once the host has room, the idle pass log saying REOPENED or KEPT with why (or run: ${KIT_NAME} open ${id})`;
    case 'closed':
      return `CLOSED: ${label} was not woken: ${wake.why}; the idle pass tries again each minute, or run: ${KIT_NAME} open ${id}`;
  }
}
