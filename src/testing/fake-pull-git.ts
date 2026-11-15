import type { GitOutcome } from '../core/git-run.ts';
import { pullRef, type MergeTreeOutcome, type PullGit } from '../github/pull-conflicts.ts';

/**
 * A clone for the pull request conflict check, in memory: its origin is `acme/web` on GitHub, with `main` at `base`
 * and pull request 7's head at `head`. A fetch copies origin's branches to `origin/<name>` and the pull request's
 * head to its teamrig ref; `merges` holds the outcome of merging a head into a base, by `<base>+<head>` (clean
 * unless set). Each step is logged in `log`; a test sets `fetchFails` to make the fetch fail.
 */
export class FakePullGit implements PullGit {
  readonly log: string[] = [];
  /** The GitHub repository of each folder's origin; a folder not here has no origin on GitHub. */
  readonly repos = new Map<string, string>([['/repo/web', 'acme/web']]);
  readonly originBranches = new Map<string, string>([['main', 'base']]);
  /** The head of each open pull request on origin, by number. */
  readonly pulls = new Map<number, string>([[7, 'head']]);
  readonly merges = new Map<string, MergeTreeOutcome>();
  fetchFails: string | undefined;
  private readonly refs = new Map<string, string>();

  remoteRepo(dir: string, remote: string): string | undefined {
    this.log.push(`remote ${dir} ${remote}`);
    return this.repos.get(dir);
  }

  fetchPull(dir: string, remote: string, number: number): GitOutcome {
    this.log.push(`fetch ${dir} ${remote} ${number}`);
    if (this.fetchFails !== undefined) {
      return { ok: false, reason: this.fetchFails };
    }
    for (const [name, sha] of this.originBranches) {
      this.refs.set(`${remote}/${name}`, sha);
    }
    const head = this.pulls.get(number);
    if (head === undefined) {
      return { ok: false, reason: `couldn't find remote ref refs/pull/${number}/head` };
    }
    this.refs.set(pullRef(number), head);
    return { ok: true };
  }

  defaultBranch(): string {
    return 'main';
  }

  sha(_dir: string, ref: string): string | undefined {
    return this.refs.get(ref);
  }

  mergeTree(dir: string, base: string, head: string): MergeTreeOutcome {
    this.log.push(`merge-tree ${dir} ${base} ${head}`);
    return this.merges.get(`${base}+${head}`) ?? { kind: 'clean' };
  }
}
