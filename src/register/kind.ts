import type { Task } from './fold.ts';

/**
 * The hint that asks to mark a task a problem (T916): a task no one marked (`kind` null) whose title or description
 * matches `pattern` (the team's `register.review.hintPattern`, validated as a `u` regex), case-insensitively, names
 * the word that matched and the command that marks it. A marked task, `--problem none` included, gets no hint.
 */
export function problemHint(task: Pick<Task, 'id' | 'kind' | 'title' | 'description'>, pattern: string): string | undefined {
  if (task.kind !== null) {
    return undefined;
  }
  const matcher = new RegExp(pattern, 'iu');
  const match = matcher.exec(task.title) ?? (task.description === null ? null : matcher.exec(task.description));
  if (match === null) {
    return undefined;
  }
  return `${task.id} looks like a problem ("${match[0]}"): mark it with teamrig update ${task.id} --problem problem|critical, or --problem none`;
}
