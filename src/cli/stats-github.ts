import { formatW } from '../budget/format.ts';
import { taskWOf } from '../budget/task-use.ts';
import { ISSUE_REF_PREFIX } from '../register/model.ts';
import type { Task } from '../register/fold.ts';
import type { RolledTeam } from './roll-up.ts';
import type { CliRuntime } from './runtime.ts';
import { readStoredUsage } from './stored-week.ts';

/** The GitHub-linked tasks the `GITHUB` line names, costliest first; the rest it only counts. */
export const GITHUB_TASKS_SHOWN = 6;

/**
 * `stats`'s GITHUB line (T3028, design T3021 section 4): the W the meter kept on each task that tracks a GitHub issue
 * or pull request (its ref `gh:<repo>#<n>`), costliest first, so the lead sees what answering outside threads costs.
 * Internal: never posted to GitHub. No line when no such task has metered W.
 */
export function githubWLines(tasks: Iterable<Pick<Task, 'id' | 'ref'>>, wByTask: ReadonlyMap<string, number>): string[] {
  const spent = [...tasks]
    .flatMap((task) => {
      const w = wByTask.get(task.id) ?? 0;
      return task.ref !== null && task.ref.startsWith(ISSUE_REF_PREFIX) && w > 0 ? [{ id: task.id, ref: task.ref, w }] : [];
    })
    .sort((a, b) => b.w - a.w || a.id.localeCompare(b.id));
  if (spent.length === 0) {
    return [];
  }
  const total = spent.reduce((sum, task) => sum + task.w, 0);
  const shown = spent.slice(0, GITHUB_TASKS_SHOWN).map((task) => `${task.id} ${task.ref} ${formatW(task.w)}`);
  const more = spent.length > GITHUB_TASKS_SHOWN ? `, ${spent.length - GITHUB_TASKS_SHOWN} more` : '';
  return [`GITHUB ${spent.length} linked task(s) used ${formatW(total)} W as metered: ${shown.join(', ')}${more}; internal, never posted`];
}

/** The GITHUB line of a team's tasks, those of one session when `session` names it, from the meter's stored use. */
export async function githubUseLines(runtime: CliRuntime, team: Pick<RolledTeam, 'paths' | 'config'>, tasks: Iterable<Task>, session: string | undefined): Promise<string[]> {
  const wByTask = taskWOf((await readStoredUsage(runtime, team.paths, team.config.sessions)).values());
  return githubWLines([...tasks].filter((task) => session === undefined || task.owner === session), wByTask);
}
