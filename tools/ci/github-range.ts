import { isRecord, recordField, stringField, type JsonRecord } from '../lib/guards.ts';

const NULL_SHA = /^0+$/;

/**
 * The revisions a CI run must check: a pull request's own commits, a push's new commits,
 * or, for a new branch and any other event, the whole history of the head commit.
 */
export function rangeFromGithubEvent(eventName: string, payload: unknown, headSha: string): string {
  const event: JsonRecord = isRecord(payload) ? payload : {};
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const pullRequest = recordField(event, 'pull_request') ?? {};
    const base = stringField(recordField(pullRequest, 'base') ?? {}, 'sha');
    const head = stringField(recordField(pullRequest, 'head') ?? {}, 'sha');
    if (base === undefined || head === undefined) {
      throw new Error(`${eventName} event without base and head shas`);
    }
    return `${base}..${head}`;
  }
  if (eventName === 'push') {
    const before = stringField(event, 'before');
    const after = stringField(event, 'after') ?? headSha;
    return before === undefined || NULL_SHA.test(before) ? after : `${before}..${after}`;
  }
  return headSha;
}

export type ReadText = (path: string) => Promise<string>;

/** Reads the event from the GitHub Actions environment (GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_SHA). */
export async function rangeFromGithubEnv(
  env: Readonly<Record<string, string | undefined>>,
  readText: ReadText,
): Promise<string> {
  const eventName = env['GITHUB_EVENT_NAME'];
  const eventPath = env['GITHUB_EVENT_PATH'];
  const headSha = env['GITHUB_SHA'];
  if (!eventName || !eventPath || !headSha) {
    throw new Error('--github needs GITHUB_EVENT_NAME, GITHUB_EVENT_PATH and GITHUB_SHA');
  }
  const payload: unknown = JSON.parse(await readText(eventPath));
  return rangeFromGithubEvent(eventName, payload, headSha);
}
