import type { Gh } from './github.ts';
import { arrayOf, booleanAt, isRecord, numberAt, recordAt, recordOf, stringAt } from './json.ts';

/** The pull request calls ship makes (Pull requests: read and write). */

export interface PullRequest {
  number: number;
  url: string;
  headRef: string;
  headSha: string;
  baseRef: string;
}

export function parsePull(item: Record<string, unknown>): PullRequest {
  const head = recordAt(item, 'head', 'pull request');
  const base = recordAt(item, 'base', 'pull request');
  return {
    number: numberAt(item, 'number', 'pull request'),
    url: stringAt(item, 'html_url', 'pull request'),
    headRef: stringAt(head, 'ref', 'pull request head'),
    headSha: stringAt(head, 'sha', 'pull request head'),
    baseRef: stringAt(base, 'ref', 'pull request base'),
  };
}

/** The open pull request from `head` into `base` in the repo itself (GitHub allows one at a time), if any. */
export function findOpenPull(gh: Gh, repo: string, head: string, base: string): PullRequest | null {
  const owner = repo.split('/')[0] ?? '';
  const pulls = arrayOf(gh(['api', `repos/${repo}/pulls?state=open&base=${base}&head=${owner}:${head}&per_page=10`]), 'open pull requests').map(parsePull);
  if (pulls.length > 1) throw new Error(`${repo}: ${pulls.length} open pull requests from ${head} into ${base}`);
  return pulls[0] ?? null;
}

export function openPull(gh: Gh, repo: string, head: string, base: string, title: string, body: string): PullRequest {
  const created = gh(['api', `repos/${repo}/pulls`, '-X', 'POST', '-f', `title=${title}`, '-f', `head=${head}`, '-f', `base=${base}`, '-f', `body=${body}`]);
  return parsePull(recordOf(created, 'new pull request'));
}

/** An open pull request with the repo its head branch lives in (`owner/name`); null when that repo was deleted. */
export interface OpenPull extends PullRequest {
  headRepo: string | null;
}

/** Every open pull request into `base`, from any branch or fork (the first 100, which GitHub lists newest first). */
export function openPullsInto(gh: Gh, repo: string, base: string): OpenPull[] {
  return arrayOf(gh(['api', `repos/${repo}/pulls?state=open&base=${base}&per_page=100`]), 'open pull requests').map(item => {
    const headRepo = recordAt(item, 'head', 'pull request')['repo'];
    return { ...parsePull(item), headRepo: isRecord(headRepo) ? stringAt(headRepo, 'full_name', 'pull request head repo') : null };
  });
}

/** Comments `comment` on pull request `number`, then closes it unmerged; GitHub keeps its branch and a Reopen button. */
export function closePull(gh: Gh, repo: string, number: number, comment: string): void {
  gh(['api', `repos/${repo}/issues/${number}/comments`, '-X', 'POST', '-f', `body=${comment}`]);
  gh(['api', `repos/${repo}/pulls/${number}`, '-X', 'PATCH', '-f', 'state=closed']);
}

export type MergeOutcome = { merged: true; sha: string } | { merged: false; message: string };

/**
 * Rebase-merges a pull request, only while its head is still `sha`: GitHub answers 409 when the head
 * moved, so a commit pushed after the checks were read can never merge unchecked.
 */
export function rebaseMerge(gh: Gh, repo: string, pull: number, sha: string): MergeOutcome {
  const body = recordOf(gh(['api', `repos/${repo}/pulls/${pull}/merge`, '-X', 'PUT', '-f', 'merge_method=rebase', '-f', `sha=${sha}`]), 'merge');
  if (booleanAt(body, 'merged', 'merge')) return { merged: true, sha: stringAt(body, 'sha', 'merge') };
  return { merged: false, message: stringAt(body, 'message', 'merge') };
}
