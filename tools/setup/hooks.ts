import type { Git } from '../lib/git.ts';
import { DENYLIST_CONFIG_KEY } from '../scrub/run.ts';

export const HOOKS_PATH = '.githooks';

export interface HookSetupReport {
  readonly hooksPath: string;
  /** The configured private denylist path, if any. */
  readonly denylist: string | undefined;
}

/** Points this clone's git at the repo's hooks; reports whether a private denylist is wired in. */
export async function configureHooks(git: Git): Promise<HookSetupReport> {
  await git.text(['config', '--local', 'core.hooksPath', HOOKS_PATH]);
  const denylist = (await git.text(['config', '--default', '', '--get', DENYLIST_CONFIG_KEY])).trim();
  return { hooksPath: HOOKS_PATH, denylist: denylist === '' ? undefined : denylist };
}
