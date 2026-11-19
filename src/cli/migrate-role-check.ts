import { relative, resolve, sep } from 'node:path';
import { taskFolder, tasksFolder, type TeamPaths } from '../core/home.ts';
import { isAtOrBelow, samePath } from '../core/paths.ts';
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
