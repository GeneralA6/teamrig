/**
 * The SessionStart line for a session in a Claude Code worktree (`<repo>/.claude/worktrees/<name>`, made by
 * EnterWorktree or `claude --worktree`). Claude Code isolates such a session: it refuses a shell command it cannot
 * prove stays inside the worktree, such as a variable where an option may stand, git in a compound command, git sent
 * to the shared checkout, or PowerShell started from Bash. Those refusals were one team's second most common failed
 * call in a week, 464 of them in sessions started in such a folder (T1380), so the session learns the forms first.
 */

import { claudeWorktreeRepo } from '../core/paths.ts';

export const WORKTREE_NOTE =
  'This session runs in a Claude Code worktree, whose guard refuses a shell command it cannot prove stays inside it: ' +
  'write paths out in full, not as variables (or put -- before one); run git as one plain command from this folder, ' +
  'never with cd or -C into the shared checkout; and start no PowerShell from Bash.';

/**
 * The line for a start whose folder is at or under a Claude Code worktree, its folder names in any case where the
 * filesystem ignores it; undefined for any other folder or none.
 */
export function worktreeNoteOf(cwd: string | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
  return cwd !== undefined && claudeWorktreeRepo(cwd, platform) !== undefined ? WORKTREE_NOTE : undefined;
}
