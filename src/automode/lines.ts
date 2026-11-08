import type { PushGuardConfig, PushToProtected } from '../config/types.ts';

/**
 * The lines teamrig adds to Claude Code's `autoMode.environment` setting: what auto mode's classifier should take as
 * the trusted ground truth of a teamrig team (its protected branches, the register commands every session runs, what
 * `queue` and `test` wrap, who removes a worktree, that a session may rebase its own branch, and that editing a clean
 * tracked file in its own worktree is not destruction). A plugin cannot ship them (a plugin's settings take only `agent` and
 * `subagentStatusLine`), so `teamrig automode install` writes them into the person's own settings. Each line starts
 * with the team's tag, which is how install and uninstall find their own lines and leave every other one alone.
 */

/** The facts of one team the lines are filled from. */
export interface AutoModeFacts {
  readonly team: string;
  /** The team's home folder as the person reads it (`~/.teamrig/teams/<team>`), where the register commands write. */
  readonly home: string;
  readonly lead: string;
  /** Only the keys the lines name: the protected branches and how a push to one goes. */
  readonly pushGuard: Pick<PushGuardConfig, 'protectedBranches' | 'pushToProtected'>;
}

/**
 * The register commands every session of a team may run on its own: each only reads or writes the team's own files.
 * Each is a command name of the CLI, which a test holds it to.
 */
export const REGISTER_COMMANDS = [
  'start',
  'add',
  'set',
  'update',
  'verify',
  'list',
  'show',
  'check',
  'plan',
  'budget',
  'rules',
  'refresh',
  'inbox read',
  'inbox status',
  'inbox add',
  'who',
  'rename',
] as const;

/** The tag every line of the team's starts with, a space included. */
export function kitTag(team: string): string {
  return `[teamrig ${team}] `;
}

/** One of the team's lines: what the `automode install` help calls it, and how it is filled from the team. */
interface KitLine {
  readonly subject: string;
  readonly fill: (facts: AutoModeFacts) => string;
}

/**
 * The team's lines, in order. Each line carries its subject so the `automode install` help cannot drift from them:
 * when the help named each line by hand, T974's sixth line shipped with a help that still listed five.
 */
const KIT_LINES: readonly KitLine[] = [
  { subject: 'protected branches', fill: branchesLine },
  { subject: 'the register commands', fill: registerLine },
  { subject: 'queue and test', fill: wrappersLine },
  { subject: 'who removes a worktree', fill: worktreeLine },
  { subject: "rebasing one's own branch", fill: rebaseLine },
  { subject: "editing a clean tracked file in one's own worktree", fill: cleanFilesLine },
];

/** What the `automode install` help names each line by, in the lines' order; a spec holds the help to every one. */
export const KIT_LINE_SUBJECTS: readonly string[] = KIT_LINES.map((line) => line.subject);

/** The team's lines, each starting with the team's tag. */
export function kitLines(facts: AutoModeFacts): string[] {
  const tag = kitTag(facts.team);
  return KIT_LINES.map((line) => `${tag}${line.fill(facts)}`);
}

function branchesLine({ lead, pushGuard }: AutoModeFacts): string {
  return (
    `Protected branches: ${pushGuard.protectedBranches.join(', ')}. ${normalPush(pushGuard.pushToProtected, lead)} ` +
    'A force-push, a --mirror push or deleting one is refused, and a --force-with-lease push asks. ' +
    "Every session edits on its own branch in its own git worktree, never in a repo's main checkout."
  );
}

function normalPush(mode: PushToProtected, lead: string): string {
  switch (mode) {
    case 'ask':
      return 'A normal push to one asks the person.';
    case 'allow':
      return 'A normal push to one goes through with a note.';
    case 'lead':
      return (
        `A normal push to one goes through only for the lead (session ${lead}) or for a session whose waiting task the ` +
        'lead approved with `teamrig approve`; any other session is refused.'
      );
    case 'gated':
      return (
        `A normal push to one goes through only for the lead (session ${lead}) or for a session whose waiting task the ` +
        "lead approved with `teamrig approve`; any other session merges with `teamrig merge`, which merges a change that holds the self-merge gates with no approval and holds one that misses a gate for a leader's."
      );
  }
}

function registerLine({ team, home }: AutoModeFacts): string {
  const names = REGISTER_COMMANDS.map((name) => `teamrig ${name}`).join(', ');
  return `The task register: every session may run ${names} for team ${team}; they write only under ${home}/.`;
}

function wrappersLine(): string {
  return (
    '`teamrig queue ... -- <cmd>` and `teamrig test ... -- <cmd>` run the session\'s own build, test or script on this ' +
    'host (queue waits for the host lock, test records the result); neither grants anything, so judge the command ' +
    'after `--` as if it ran alone.'
  );
}

function worktreeLine({ lead }: AutoModeFacts): string {
  return (
    '`teamrig worktree remove <path> [--delete-branch]` is how a session removes its finished worktree, and every session ' +
    'may run it: teamrig itself removes only a worktree whose t<id>- branch names a task the session owns or one of a ' +
    `session it leads (any for the lead, session ${lead}), and refuses the main checkout, uncommitted work and a branch ` +
    'with a commit not on its base.'
  );
}

/**
 * The owner's grant of 10-26: every session may rebase its own branch. A rebase rewrites only that session's own
 * commits; a protected branch stays under the branches line, which refuses rewriting one and asks before a leased push.
 */
function rebaseLine({ pushGuard }: AutoModeFacts): string {
  return (
    'Every session may rebase its own branch in its own git worktree onto the fresh default branch (`git fetch`, then ' +
    '`git rebase origin/<branch>` or `git pull --rebase`, and `git rebase --continue` or `--abort` to settle a stopped ' +
    "one): it rewrites only that session's own commits not yet merged. A branch it pushed before goes back with " +
    `\`git push --force-with-lease\` to that same branch. A protected branch (${pushGuard.protectedBranches.join(', ')}) ` +
    "is never rebased, nor a repo's main checkout."
  );
}

/**
 * Editing a clean tracked file in a session's own worktree is ordinary code editing: git restores it. Without this line
 * a classifier told not to delete or overwrite files a session did not create refused such edits (no session creates a
 * tracked file) and left a worktree half-edited. Security's verdict on that false flag set the limits named here: only
 * clean files, only means git can undo, only scripts the session has seen, never agent config or gates (a deleted hook
 * amounts to skipping it), and never a folder delete, which can follow a node_modules junction into the main checkout.
 */
function cleanFilesLine(): string {
  return (
    "In a session's own git worktree on its own branch, a file git tracks with no uncommitted change (clean in " +
    '`git status`) comes back with `git restore`, so editing it with Edit or Write, deleting or moving it with `git rm` ' +
    '(without `-f`) or `git mv`, or running a script the session wrote or read in full whose writes stay in that ' +
    'worktree, is ordinary code editing, not destruction. It does not cover `rm -rf` of a folder (it also deletes ' +
    'untracked and ignored files, and can follow a junction into the main checkout), git commands that discard work ' +
    'or history (`reset --hard`, `checkout --` or `restore` over uncommitted changes, `clean`, `stash drop` or ' +
    '`clear`, `branch -D`, `git worktree remove`, `gc --prune`, `reflog expire`), a file with uncommitted changes, ' +
    "an untracked or ignored file, another session's worktree, a repo's main checkout, or agent config and gates " +
    'even when tracked (`.claude/`, `CLAUDE.md`, `.husky/`, git hooks).'
  );
}
