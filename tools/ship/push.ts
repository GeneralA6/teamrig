/**
 * Pushes the checked-out change branch for `ship.ts --merge` (T629), never main: the auto-mode briefing grants
 * the teamrig session pushes of its own non-main branches, and main only moves through merge.ts.
 *
 * A branch pushed by an earlier ship and since rebased onto main (sync.ts) no longer fast-forwards, so the push
 * replaces it with a lease on the sha origin had when this push began: anything else that wrote the branch since
 * makes the push fail instead of being lost.
 */

const MERGED_INTO = ['main', 'master'];

export function pushOwnBranch(git: (...args: string[]) => string, main: string): string {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === 'HEAD') throw new Error('REFUSED the repo dir has a detached HEAD: check out the change branch');
  if (branch === main || MERGED_INTO.includes(branch)) throw new Error(`REFUSED ${branch} is a branch changes merge into: ship a change branch`);
  const [pushed = ''] = git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`).split('\t');
  const lease = pushed === '' ? [] : [`--force-with-lease=refs/heads/${branch}:${pushed}`];
  git('push', '--quiet', ...lease, 'origin', `HEAD:refs/heads/${branch}`);
  return branch;
}
