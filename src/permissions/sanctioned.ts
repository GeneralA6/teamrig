import { matchesGitCommit, matchesGitPush, type GitContext } from './route-git.ts';
import { KIT_SHAPES, matchesKit, type KitContext, type KitShape } from './route-kit.ts';
import { plainWordsOf } from './route-line.ts';

/**
 * The sanctioned-route table (T679, design M1, security rulings C1-C8): the teamrig and git commands a session runs as
 * its own job, which no refusal or prompt should leave a dead end. A Bash line is a route when it is one plain command
 * (C1) that an entry matches; nothing in config widens the table. The PermissionRequest answer reads every entry, the
 * PreToolUse allow only those marked `preToolUse` (Q7.3), the refusal texts each `purpose`, the canary spec each
 * `canary`.
 */

/** What every route needs beyond the line's words. */
export type RouteContext = KitContext & GitContext;

export type RouteId = 'merge' | 'deploy' | 'exec-request' | 'worktree-remove' | 'register' | 'git-commit' | 'git-push';

export interface SanctionedRoute {
  readonly id: RouteId;
  /** What a session runs it for, in words a refusal can name. */
  readonly purpose: string;
  /** A harmless line the entry matches where its context holds (the canary session owns T1), fed to every guard; never run. */
  readonly canary: string;
  /** True when PreToolUse may allow it too (Q7.3): the routes the owner granted already, or that stay local. */
  readonly preToolUse: boolean;
  readonly match: (words: readonly string[], context: RouteContext) => Promise<boolean>;
}

const kit = (shape: KitShape): SanctionedRoute['match'] => async (words, context) => matchesKit(shape, words, context);

/** The table, in the order {@link routeOf} asks; no line matches two entries. */
export const SANCTIONED_ROUTES: readonly SanctionedRoute[] = [
  {
    id: 'merge',
    purpose: "merge the branch checked out here into origin's default branch",
    canary: 'teamrig merge --session tr-canary',
    preToolUse: true,
    match: kit(KIT_SHAPES.merge),
  },
  {
    id: 'deploy',
    purpose: "bring what was pushed to a repository's default branch to the running system",
    canary: 'teamrig deploy --session tr-canary --repo canary',
    preToolUse: true,
    match: kit(KIT_SHAPES.deploy),
  },
  {
    id: 'exec-request',
    purpose: 'ask the security reviewer to run a privileged command',
    canary: 'teamrig exec request --session tr-canary --file C:/canary/request.json',
    preToolUse: true,
    match: kit(KIT_SHAPES.execRequest),
  },
  {
    id: 'worktree-remove',
    purpose: 'remove a worktree of your own, unlinking its node_modules first',
    canary: 'teamrig worktree remove C:/canary/t1-canary --session tr-canary --dry-run',
    preToolUse: true,
    match: kit(KIT_SHAPES.worktreeRemove),
  },
  {
    id: 'register',
    purpose: 'read and write the task register and the inbox',
    canary: 'teamrig list --session tr-canary',
    preToolUse: false,
    match: kit(KIT_SHAPES.register),
  },
  {
    id: 'git-commit',
    purpose: 'commit with the hooks running',
    canary: 'git -C C:/canary commit -s -m canary',
    preToolUse: true,
    match: async (words) => matchesGitCommit(words),
  },
  {
    id: 'git-push',
    purpose: 'push a task branch you own to a configured remote',
    canary: 'git -C C:/canary push -u origin t1-canary',
    preToolUse: false,
    match: matchesGitPush,
  },
];

/** The route `line` runs, when it is one plain command an entry matches; else undefined. */
export async function routeOf(line: string, context: RouteContext): Promise<SanctionedRoute | undefined> {
  const words = plainWordsOf(line);
  if (words === undefined) {
    return undefined;
  }
  for (const route of SANCTIONED_ROUTES) {
    if (await route.match(words, context)) {
      return route;
    }
  }
  return undefined;
}
