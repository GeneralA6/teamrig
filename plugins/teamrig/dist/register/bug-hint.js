/**
 * The hint that asks to mark a task a bug (T916, T1252): a task no one gave a type (`type` null) whose title or
 * description matches `pattern` (the team's `register.review.hintPattern`, validated as a `u` regex), case-insensitively,
 * names the word that matched and the command that marks it. A typed task, `--type task` included, gets no hint.
 */
export function bugHint(task, pattern) {
    if (task.type !== null) {
        return undefined;
    }
    const matcher = new RegExp(pattern, 'iu');
    const match = matcher.exec(task.title) ?? (task.description === null ? null : matcher.exec(task.description));
    if (match === null) {
        return undefined;
    }
    return `${task.id} looks like a bug ("${match[0]}"): mark it with teamrig update ${task.id} --type bug [--critical], or --type task`;
}
