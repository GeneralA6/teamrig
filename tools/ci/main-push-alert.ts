import { EXIT_CLEAN } from '../lib/exit.ts';
import { isRecord, recordField, stringField } from '../lib/guards.ts';
import type { ReadText } from './github-range.ts';

/** The committer GitHub records on the commits it writes itself, such as a pull request's merge or rebase. */
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
 * Whether main changed outside a pull request: a force push, or a head commit GitHub did not write.
 * The workflow's `if:` holds the same test, so a merge starts no job and bills no minutes.
 */
export function isOutsidePullRequest(push: MainPush): boolean {
  return push.forced || push.committer !== GITHUB_COMMITTER;
}

/** The issue that reports the push, with what to check and how to undo it. */
export function alertIssue(push: MainPush): AlertIssue {
  const how = push.forced ? 'Force push' : 'Push';
  return {
    title: `${how} to main outside a pull request, by ${push.pusher}`,
    body: [
      `${push.pusher} changed main without a pull request. Every change lands on main through a pull request (CONTRIBUTING.md).`,
      '',
      `- before: \`${push.before}\``,
      `- after: \`${push.after}\``,
      `- forced: ${push.forced ? 'yes' : 'no'}`,
      `- head commit committer: \`${push.committer ?? 'none'}\` (GitHub commits a pull request merge as \`${GITHUB_COMMITTER}\`)`,
      ...(push.compare === undefined ? [] : [`- changes: ${push.compare}`]),
      '',
      'Check the changes. If they were not meant, undo them through a pull request; a force push that dropped commits needs',
      '`before` pushed back by the owner. A clone set up with `npm install` refuses a push to main in its pre-push hook.',
    ].join('\n'),
  };
}

/**
 * Reads the push from the GitHub Actions environment (GITHUB_EVENT_NAME, GITHUB_EVENT_PATH) and opens
 * an issue when main changed outside a pull request.
 */
export async function raiseMainPushAlert(
  env: Readonly<Record<string, string | undefined>>,
  readText: ReadText,
  createIssue: CreateIssue,
  out: (line: string) => void,
): Promise<number> {
  const eventPath = env['GITHUB_EVENT_PATH'];
  if (env['GITHUB_EVENT_NAME'] !== 'push' || !eventPath) {
    throw new Error('needs a push event: GITHUB_EVENT_NAME=push and GITHUB_EVENT_PATH');
  }
  const push = mainPushFromEvent(JSON.parse(await readText(eventPath)));
  if (!isOutsidePullRequest(push)) {
    out(`main-push-alert: ${push.after} is a pull request merge, no alert`);
    return EXIT_CLEAN;
  }
  const issue = await createIssue(alertIssue(push));
  out(`main-push-alert: opened ${issue.trim()}`);
  return EXIT_CLEAN;
}
