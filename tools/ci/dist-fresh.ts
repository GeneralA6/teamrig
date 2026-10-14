import type { Git } from '../lib/git.ts';

/** The compiled plugin code, committed so an installed plugin runs without a build step. */
export const DIST_DIR = 'plugins/teamrig/dist';

/**
 * After `npm run build`, any added, changed or deleted file under the dist folder means the
 * committed build is stale. Returns the offending `git status --porcelain` lines.
 */
export async function staleDistEntries(git: Git): Promise<string[]> {
  const status = await git.text(['status', '--porcelain', '--untracked-files=all', '--', DIST_DIR]);
  return status.split('\n').filter((line) => line.trim() !== '');
}
