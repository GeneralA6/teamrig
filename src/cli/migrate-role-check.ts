import { relative, resolve, sep } from 'node:path';
import type { Files } from '../core/files.ts';
import { taskFolder, tasksFolder, type TeamPaths } from '../core/home.ts';
import { isAtOrBelow, samePath } from '../core/paths.ts';
import { SecretScanner } from '../core/secrets.ts';
import { parseMigrateRows } from '../sync/migrate.ts';
import { TASK_ID } from '../register/model.ts';

/**
 * The rows file a role's `issue migrate` runs on, when it sits in one task folder of the holder's team (T4606):
 * `<team>/tasks/T<n>/...`, the files `teamrig files` gives each task, so every row the role turns into a public issue
 * was written where the team keeps its task files and can be read there after. The path as the log names it, resolved;
 * undefined for a file anywhere else, the tasks folder itself or a task folder itself, so the permission check decides.
 */
export function migrateRowsFileOf(paths: Pick<TeamPaths, 'kitHome' | 'team'>, file: string): string | undefined {
  const path = resolve(file);
  const [id] = relative(resolve(tasksFolder(paths.kitHome, paths.team)), path).split(sep);
  if (id === undefined || !TASK_ID.test(id)) {
    return undefined;
  }
  const folder = resolve(taskFolder(paths.kitHome, paths.team, id));
  return isAtOrBelow(path, folder) && !samePath(path, folder) ? path : undefined;
}

/** The most of a rows file the role's allow reads to weigh it; a longer file is left to the permission check. */
export const MIGRATE_ROWS_MAX_BYTES = 1024 * 1024;

/**
 * What a role's migrate of the rows file at `path` weighs toward the daily cap (C6, T4606): its issue rows, each an
 * issue the run may open, and at least one, as every call is. Undefined, so the permission check decides, for a file
 * that is missing or no regular file, reaches MIGRATE_ROWS_MAX_BYTES (it may hold more than was read) or holds a row the
 * run refuses. The run reads the file again as it starts, at once after the allow, from a task folder of the team.
 */
export async function migrateWeightOf(files: Pick<Files, 'readHead'>, path: string, secretPatterns: readonly string[]): Promise<number | undefined> {
  const text = await files.readHead(path, MIGRATE_ROWS_MAX_BYTES);
  if (text === undefined || Buffer.byteLength(text) >= MIGRATE_ROWS_MAX_BYTES) {
    return undefined;
  }
  const rows = parseMigrateRows(text, new SecretScanner(secretPatterns));
  return rows.ok ? Math.max(1, rows.value.filter((row) => row.decision === 'issue').length) : undefined;
}
