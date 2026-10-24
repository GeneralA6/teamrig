import type { IdleMode } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import type { TeamPaths } from '../core/home.ts';
import { idlePassTrouble, parseIdlePassState, type IdlePassState } from './idle-pass-log.ts';
import { idlePassWarning, type UnownedWarning } from './unowned.ts';

/** The team's idle pass state (`state/idle-pass.json`); undefined with no pass yet or a damaged file. */
export async function readIdlePassState(files: Files, paths: Pick<TeamPaths, 'idlePass'>): Promise<IdlePassState | undefined> {
  return parseIdlePassState((await files.read(paths.idlePass)) ?? '');
}

/**
 * FLEET-STALE (T1100), for `check`: while `open.idle.mode` is not off, a pass that has not run for
 * `IDLE_PASS_STALE_MS`, or whose last run failed, closes and reopens no one, so it is a warning no session owns and
 * goes to the lead. With mode off it reads nothing.
 */
export async function idlePassWarnings(files: Files, paths: Pick<TeamPaths, 'idlePass'>, mode: IdleMode, now: number): Promise<UnownedWarning[]> {
  if (mode === 'off') {
    return [];
  }
  const trouble = idlePassTrouble(await readIdlePassState(files, paths), now);
  return trouble === undefined ? [] : [idlePassWarning(trouble, mode, now)];
}
