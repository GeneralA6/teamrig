/**
 * The branch head a ship run starts from, held until the run has committed its plan again (#1240). Before its commits a
 * run takes back the commits its earlier run made (rerun.ts) and may rebase onto a moved main (sync.ts); a refusal or a
 * failed step in between used to leave the branch on main with the change as loose edits, so the next --merge run was
 * refused at once, its approved head no longer the branch head, and the branch took a checkout by hand. `restore` puts
 * the branch back on the head the run started from, with the plan's uncommitted changes on it.
 */

export interface HoldDeps {
  /** Runs git in the repo dir and returns its trimmed stdout; throws when git fails. */
  readonly git: (...args: string[]) => string;
  readonly log: (line: string) => void;
}

export interface HeldHead {
  /** The commit the run started from. */
  readonly head: string;
  /** Puts the branch back on `head`, the tree as it was then; throws naming what to run when the plan cannot go back on. */
  readonly restore: () => void;
}

const untrackedIn = (git: HoldDeps['git']): string[] => git('ls-files', '-z', '--others', '--exclude-standard').split('\0').filter((path) => path !== '');

export function holdHead(deps: HoldDeps): HeldHead {
  const { git } = deps;
  const head = git('rev-parse', 'HEAD');
  const untracked = new Set(untrackedIn(git));
  // A stash commit no ref names, as sync.ts sets the plan aside: the stash list is shared by every worktree of the clone.
  const saved = git('stash', 'create', 'ship.ts: the plan, held until the run commits it again');
  // Named now, as sync.ts does: if a restore step before the apply throws, its error is what the run reports.
  if (saved !== '') deps.log(`held the plan's uncommitted changes as ${saved} (git stash apply ${saved} brings them back)`);
  const restore = (): void => {
    // A mixed reset first: a file the run committed that was untracked at the start becomes untracked again instead of
    // being deleted by the hard reset, which then sets every tracked file back to the head's.
    git('reset', '--quiet', head);
    git('reset', '--quiet', '--hard');
    const strays = untrackedIn(git).filter((path) => !untracked.has(path));
    // Literal: git reads a pathspec as a glob even after --, so a stray named `[n]ew.txt` would also clean `new.txt`,
    // an untracked plan file that `stash create` did not save. Magic per path, as src/worktree/git.ts does: the global
    // --literal-pathspecs flag dies when the environment sets GIT_GLOB_PATHSPECS or GIT_ICASE_PATHSPECS.
    if (strays.length > 0) git('clean', '-fq', '--', ...strays.map((path) => `:(literal)${path}`));
    if (saved !== '') {
      try {
        git('stash', 'apply', '--quiet', saved);
      } catch {
        throw new Error(`the branch is back on ${head.slice(0, 9)}, but putting the plan back on it failed: git stash apply ${saved} restores it`);
      }
    }
    deps.log(`the branch is back on ${head.slice(0, 9)}, the head this run started from, with the plan uncommitted on it`);
  };
  return { head, restore };
}
