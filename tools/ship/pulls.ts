import type { Gh } from './github.ts';
import { arrayOf, booleanAt, numberAt, recordAt, recordOf, stringAt } from './json.ts';

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
