import type { PushGuardConfig, PushToProtected } from '../config/types.ts';

/**
 * The lines teamrig adds to Claude Code's `autoMode.environment` setting: what auto mode's classifier should take as
 * the trusted ground truth of a teamrig team (its protected branches, the register commands every session runs, what
 * `heavy` and `test` wrap, and who removes a worktree). A plugin cannot ship them (a plugin's settings take only `agent` and
 * `subagentStatusLine`), so `teamrig automode install` writes them into the person's own settings. Each line starts
 * with the team's tag, which is how install and uninstall find their own lines and leave every other one alone.
 */

/** The facts of one team the lines are filled from. */
export interface AutoModeFacts {
  readonly team: string;
  /** The team's home folder as the person reads it (`~/.teamrig/teams/<team>`), where the register commands write. */
  readonly home: string;
  readonly lead: string;
  readonly pushGuard: PushGuardConfig;
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

/** The team's lines, in order: protected branches, the register, heavy and test, worktree removal. */
export function kitLines(facts: AutoModeFacts): string[] {
  const tag = kitTag(facts.team);
  return [branchesLine(facts), registerLine(facts), wrappersLine(), worktreeLine(facts)].map((line) => `${tag}${line}`);
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
  }
}

function registerLine({ team, home }: AutoModeFacts): string {
  const names = REGISTER_COMMANDS.map((name) => `teamrig ${name}`).join(', ');
  return `The task register: every session may run ${names} for team ${team}; they write only under ${home}/.`;
}

function wrappersLine(): string {
  return (
    '`teamrig heavy ... -- <cmd>` and `teamrig test ... -- <cmd>` run the session\'s own build, test or script on this ' +
    'host (heavy waits for the host lock, test records the result); neither grants anything, so judge the command ' +
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
