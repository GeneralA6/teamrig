import { GitError, type Git } from '../lib/git.ts';
import { DENYLIST_CONFIG_KEY } from '../scrub/run.ts';

export const HOOKS_PATH = '.githooks';

/** Why the hooks were left alone. */
export type HookSkipReason = 'not a git checkout' | 'not the root of its git checkout';

export type HookSetupReport =
  | {
      readonly kind: 'configured';
      readonly hooksPath: string;
      /** The configured private denylist path, if any. */
      readonly denylist: string | undefined;
    }
  | { readonly kind: 'skipped'; readonly reason: HookSkipReason };

/**
 * Points this clone's git at the repo's hooks; reports whether a private denylist is wired in.
 * npm's `prepare` runs it on every `npm install` and `npm ci`, so it skips, never fails, where this
 * folder is not the root of a checkout: no git on the PATH, no repo (a tarball), or a copy inside
 * another repo's tree, whose own hooks it must not replace.
 */
export async function configureHooks(git: Git): Promise<HookSetupReport> {
  const skip = await notCheckoutRoot(git);
  if (skip !== undefined) {
    return { kind: 'skipped', reason: skip };
  }
  await git.text(['config', '--local', 'core.hooksPath', HOOKS_PATH]);
  const denylist = (await git.text(['config', '--default', '', '--get', DENYLIST_CONFIG_KEY])).trim();
  return { kind: 'configured', hooksPath: HOOKS_PATH, denylist: denylist === '' ? undefined : denylist };
}

async function notCheckoutRoot(git: Git): Promise<HookSkipReason | undefined> {
  let answer: string;
  try {
    // Prints `true` inside a work tree (`false` inside .git), then the folder's path below the top.
    answer = await git.text(['rev-parse', '--is-inside-work-tree', '--show-prefix']);
  } catch (error) {
    if (error instanceof GitError) {
      return 'not a git checkout';
    }
    throw error;
  }
  const [inside, prefix = ''] = answer.split(/\r?\n/);
  if (inside !== 'true') {
    return 'not a git checkout';
  }
  return prefix === '' ? undefined : 'not the root of its git checkout';
}
