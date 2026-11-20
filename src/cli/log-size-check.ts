import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import type { TeamPaths } from '../core/home.ts';
import { layoutPaths } from '../register/layout.ts';
import type { UnownedWarning } from './unowned.ts';

const MIB = 1024 * 1024;

/** The most the teamrig task pane reads of one file at once: it refuses a file past this, so its view of it stops. */
export const PANE_READ_LIMIT_BYTES = 4 * MIB;

/** Three quarters of the pane's limit, so the lead hears of a log with a quarter of the room still left to archive it. */
export const LOG_SIZE_WARN_BYTES = (PANE_READ_LIMIT_BYTES * 3) / 4;

/** The folders LOG-SIZE reads, and the files in them `teamrig compact` shrinks. */
export type LogSizePaths = Pick<TeamPaths, 'state' | 'inbox' | 'events' | 'inboxShown' | 'bindHints' | 'promptAnswers'>;

function mib(bytes: number): string {
  return (bytes / MIB).toFixed(1);
}

/**
 * What shrinks the file, as `teamrig compact` does it (cli/commands/compact.ts): it archives the register's tail
 * whole, rewrites the snapshot one line per kept task with the tasks done longest ago retired, and moves the hooks'
 * aged logs' records older than a week to the archive. No command trims any other file of the two folders, so the
 * warning says so rather than send the lead to a compact that leaves the file as it is.
 */
function remedyOf(path: string, paths: LogSizePaths): string {
  const register = layoutPaths(paths.events);
  if (path === register.snapshot) {
    return 'teamrig compact rewrites it one line per kept task, the tasks done longest ago retired to the archive';
  }
  if (path === register.tail) {
    return 'teamrig compact archives it whole and folds it into the snapshot';
  }
  if (path === paths.inboxShown || path === paths.bindHints || path === paths.promptAnswers) {
    return 'teamrig compact moves its records older than a week to the archive';
  }
  return 'no teamrig command trims it yet, so archive or trim it by hand';
}

/**
 * LOG-SIZE (T3482), for `check`: a file of the team's state or inbox folder, which the task pane reads whole, at
 * LOG_SIZE_WARN_BYTES or more, with that file's remedy. The team's state is no one session's, so it goes to the
 * lead. Its key names the file, so the lead is told once while it stands, however it grows. Only the folders' own
 * files count: a subfolder (the archive, the step logs) is never read whole.
 */
export async function logSizeWarnings(files: Pick<Files, 'list' | 'size'>, paths: LogSizePaths): Promise<UnownedWarning[]> {
  const warnings: UnownedWarning[] = [];
  for (const folder of new Set([paths.state, paths.inbox])) {
    for (const name of (await files.list(folder)).sort()) {
      const path = join(folder, name);
      const bytes = await files.size(path);
      if (bytes !== undefined && bytes >= LOG_SIZE_WARN_BYTES) {
        const text =
          `LOG-SIZE ${path} is ${mib(bytes)} MiB, near the ${mib(PANE_READ_LIMIT_BYTES)} MiB the task pane reads of a file at once, ` +
          `past which the pane stops reading it: ${remedyOf(path, paths)}`;
        warnings.push({ key: `log-size ${path}`, source: `the log size check of ${folder}`, text });
      }
    }
  }
  return warnings;
}
