import type { Gh } from './github.ts';
import { type Git, isRegenerated } from './leftovers.ts';
import { type OpenPull, type PullRequest, closePull, openPullsInto } from './pulls.ts';

/**
 * Closes the pull requests a newer push of the same change replaces (T4780). A head main moved past is pushed again
 * as `<stem>-N` (catch-up.ts, or a session's own rebase), since a force-push is refused, and each push opened its own
 * pull request; the older ones stayed open, showing "Review required" on heads nobody would merge. Once a merge or
 * `ship.ts pr` holds the pull request of its head, each older open one into the same base whose head is the same
 * stem, in the repo itself (never a fork), and whose work commits the new head all carries is closed with a comment
 * linking the new one. One whose work the new head lacks stays open with a line naming what is missing, and no
 * failure here fails the merge: each is a warning line.
 */

/** A branch's name without the `-N` suffixes reships add (`fix/t1-a-3`, `fix/t1-a-3-2` and `fix/t1-a` are one stem). */
export function stemOf(branch: string): string {
  return branch.replace(/(?:-\d+)+$/, '');
}

/**
 * The open pull requests `pull` may replace: older (a lower number, so a newer push's pull request is never closed by
 * an older merge still running), the same stem, another branch, its head in `repo` itself.
 */
export function replaceable(pull: PullRequest, open: readonly OpenPull[], repo: string): OpenPull[] {
  const stem = stemOf(pull.headRef);
  return open.filter(
    other => other.number < pull.number && other.headRef !== pull.headRef && stemOf(other.headRef) === stem && other.headRepo?.toLowerCase() === repo.toLowerCase(),
  );
}

/** The commits of a pull request's head, read through git in the repo dir. */
export interface PullCommits {
  /** Fetches pull request `number`'s head from origin (`refs/pull/<n>/head`), so its commits can be read here. */
  fetch(number: number): void;
  /** The subjects of the work commits `sha` carries over origin's main: a commit main repeats or one that only regenerates is left out. */
  subjects(sha: string): readonly string[];
}

/** PullCommits through git; `regenerated` is the profile's list of built and version paths (leftovers.ts). */
export function pullCommitsOf(git: Git, main: string, regenerated: readonly string[]): PullCommits {
  return {
    fetch: number => {
      git('fetch', '--quiet', 'origin', `refs/pull/${number}/head`);
    },
    subjects: sha =>
      git('log', '--right-only', '--cherry-pick', '--format=%x00%P%x09%s', '--name-only', `refs/remotes/origin/${main}...${sha}`)
        .split('\0')
        .filter(record => record.trim() !== '')
        .flatMap(record => {
          const [header = '', ...files] = record.split('\n').map(line => line.trim());
          const tab = header.indexOf('\t');
          const parents = header.slice(0, tab).split(' ').filter(word => word !== '');
          const subject = header.slice(tab + 1);
          const work = parents.length > 1 || files.some(file => file !== '' && !isRegenerated(file, regenerated));
          return work ? [subject] : [];
        }),
  };
}

/** Closes the open pull requests `pull` replaces; never throws. */
export type Supersede = (pull: PullRequest) => void;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

export function supersedeFrom(gh: Gh, repo: string, base: string, commits: PullCommits, log: (line: string) => void): Supersede {
  return pull => {
    let older: OpenPull[];
    try {
      older = replaceable(pull, openPullsInto(gh, repo, base), repo);
    } catch (error) {
      log(`warning: the older pull requests of ${pull.headRef} were not looked for: ${messageOf(error)}`);
      return;
    }
    if (older.length === 0) return;
    let carried: Set<string>;
    try {
      carried = new Set(commits.subjects(pull.headSha));
    } catch (error) {
      log(`warning: the older pull requests of ${pull.headRef} stay open, as its commits could not be read: ${messageOf(error)}`);
      return;
    }
    for (const other of older) {
      try {
        commits.fetch(other.number);
        const lacking = commits.subjects(other.headSha).filter(subject => !carried.has(subject));
        if (lacking.length > 0) {
          log(`warning: pull request #${other.number} ${other.url} stays open: #${pull.number} lacks its "${lacking.join('", "')}"`);
          continue;
        }
        closePull(gh, repo, other.number, `Superseded by #${pull.number} ${pull.url}: \`${pull.headRef}\` carries this change again on a newer \`${base}\`.`);
        log(`closed pull request #${other.number} ${other.url}: superseded by #${pull.number}`);
      } catch (error) {
        log(`warning: pull request #${other.number} ${other.url} was not closed: ${messageOf(error)}`);
      }
    }
  };
}
