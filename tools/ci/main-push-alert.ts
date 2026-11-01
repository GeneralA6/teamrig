import { mainPushAlertTitle } from '../../src/github/main-push-alert-title.ts';
import { EXIT_CLEAN } from '../lib/exit.ts';
import { isRecord, recordField, stringField } from '../lib/guards.ts';
import type { ReadText } from './github-range.ts';

/**
 * The committer GitHub records on the commits it writes itself, such as a pull request's merge commit or squash.
 * A rebase merge keeps the merging account as the committer instead, so it needs `MergedPullOf`.
 */
export const GITHUB_COMMITTER = 'noreply@github.com';

/** A push to main, as the alert reports it. */
export interface MainPush {
  /** The account that pushed. */
  readonly pusher: string;
  readonly before: string;
  readonly after: string;
  readonly forced: boolean;
  /** The head commit's committer e-mail. */
  readonly committer: string | undefined;
  /** GitHub's page comparing `before` with `after`. */
  readonly compare: string | undefined;
}

export interface AlertIssue {
  readonly title: string;
  readonly body: string;
}

/** Opens the issue; resolves with what `gh issue create` prints, the issue's address. */
export type CreateIssue = (issue: AlertIssue) => Promise<string>;

/** The number of the merged pull request whose merge left main at the sha (`mergedPullEndingOn`), or undefined. */
export type MergedPullOf = (sha: string) => Promise<number | undefined>;

/** Runs the GitHub CLI with the arguments, never through a shell; resolves with what it prints. */
export type RunGh = (args: readonly string[]) => Promise<string>;

/** Asks GitHub which merged pull requests brought the commit in; `gh api` fills `{owner}/{repo}` from GH_REPO. */
export function ghMergedPullOf(gh: RunGh): MergedPullOf {
  return async (sha) => mergedPullEndingOn(JSON.parse(await gh(['api', `repos/{owner}/{repo}/commits/${sha}/pulls`])), sha);
}

/** Opens the issue with `gh issue create`, which reads GH_TOKEN and GH_REPO; the text goes by argv. */
export function ghCreateIssue(gh: RunGh): CreateIssue {
  return ({ title, body }) => gh(['issue', 'create', '--title', title, '--body', body]);
}

/** The push a `push` event's payload describes. */
export function mainPushFromEvent(payload: unknown): MainPush {
  if (!isRecord(payload)) {
    throw new Error('the push event is not a JSON object');
  }
  const before = stringField(payload, 'before');
  const after = stringField(payload, 'after');
  if (before === undefined || after === undefined) {
    throw new Error('the push event has no before and after shas');
  }
  return {
    pusher: stringField(recordField(payload, 'pusher') ?? {}, 'name') ?? 'an unknown account',
    before,
    after,
    forced: payload['forced'] === true,
    committer: stringField(recordField(recordField(payload, 'head_commit') ?? {}, 'committer') ?? {}, 'email'),
    compare: stringField(payload, 'compare'),
  };
}

/**
 * Whether main may have changed outside a pull request: a force push, or a head commit GitHub did not write
 * (a direct push, or a rebase merge, which `mergedPullEndingOn` tells apart). The workflow's `if:` holds the
 * same test, so a merge commit or a squash starts no job and bills no minutes.
 */
export function mayBeOutsidePullRequest(push: MainPush): boolean {
  return push.forced || push.committer !== GITHUB_COMMITTER;
}

/**
 * The merged pull request whose merge left main at the sha, from GitHub's answer to
 * `GET /repos/{owner}/{repo}/commits/{sha}/pulls` (the merged pull requests that brought the commit in); undefined
 * when none did. A rebase merge sets the pull request's `merge_commit_sha` to the last commit it put on main.
 */
export function mergedPullEndingOn(pulls: unknown, sha: string): number | undefined {
  if (!Array.isArray(pulls)) {
    throw new Error("GitHub's pull requests of a commit are not a JSON array");
  }
  for (const pull of pulls) {
    if (isRecord(pull) && typeof pull['number'] === 'number' && stringField(pull, 'merged_at') !== undefined && pull['merge_commit_sha'] === sha) {
      return pull['number'];
    }
  }
  return undefined;
}

/** The issue that reports the push, with what to check and how to undo it. */
export function alertIssue(push: MainPush): AlertIssue {
  return {
    title: mainPushAlertTitle(push.forced, push.pusher),
    body: [
      `${push.pusher} changed main without a pull request. Every change lands on main through a pull request (CONTRIBUTING.md).`,
      '',
      `- before: \`${push.before}\``,
      `- after: \`${push.after}\``,
      `- forced: ${push.forced ? 'yes' : 'no'}`,
      '- merged pull request ending on it: none',
      ...(push.compare === undefined ? [] : [`- changes: ${push.compare}`]),
      '',
      'Check the changes. If they were not meant, undo them through a pull request; a force push that dropped commits needs',
      '`before` pushed back by the owner. A clone set up with `npm install` refuses a push to main in its pre-push hook.',
    ].join('\n'),
  };
}

/**
 * Reads the push from the GitHub Actions environment (GITHUB_EVENT_NAME, GITHUB_EVENT_PATH) and opens
 * an issue when main changed outside a pull request: a force push, or a push no merged pull request ends on.
 */
export async function raiseMainPushAlert(
  env: Readonly<Record<string, string | undefined>>,
  readText: ReadText,
  mergedPullOf: MergedPullOf,
  createIssue: CreateIssue,
  out: (line: string) => void,
): Promise<number> {
  const eventPath = env['GITHUB_EVENT_PATH'];
  if (env['GITHUB_EVENT_NAME'] !== 'push' || !eventPath) {
    throw new Error('needs a push event: GITHUB_EVENT_NAME=push and GITHUB_EVENT_PATH');
  }
  const push = mainPushFromEvent(JSON.parse(await readText(eventPath)));
  if (!mayBeOutsidePullRequest(push)) {
    out(`main-push-alert: ${push.after} is a pull request merge, no alert`);
    return EXIT_CLEAN;
  }
  const pull = push.forced ? undefined : await mergedPullOf(push.after);
  if (pull !== undefined) {
    out(`main-push-alert: ${push.after} is the rebase merge of pull request #${pull}, no alert`);
    return EXIT_CLEAN;
  }
  const issue = await createIssue(alertIssue(push));
  out(`main-push-alert: opened ${issue.trim()}`);
  return EXIT_CLEAN;
}
