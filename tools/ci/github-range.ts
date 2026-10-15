import { isRecord, recordField, stringField, type JsonRecord } from '../lib/guards.ts';

const NULL_SHA = /^0+$/;

/** The two ends of a CI run: the commit before the change (none for a new branch) and its head. */
export interface Revisions {
  readonly base: string | undefined;
  readonly head: string;
}

/**
 * The ends a CI run must compare: a pull request's base and head, a push's commit before and after,
 * or, for a new branch and any other event, the head commit alone.
 */
export function revisionsFromGithubEvent(eventName: string, payload: unknown, headSha: string): Revisions {
  const event: JsonRecord = isRecord(payload) ? payload : {};
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const pullRequest = recordField(event, 'pull_request') ?? {};
    const base = stringField(recordField(pullRequest, 'base') ?? {}, 'sha');
    const head = stringField(recordField(pullRequest, 'head') ?? {}, 'sha');
    if (base === undefined || head === undefined) {
      throw new Error(`${eventName} event without base and head shas`);
    }
    return { base, head };
  }
  if (eventName === 'push') {
    const before = stringField(event, 'before');
    const after = stringField(event, 'after') ?? headSha;
    return { base: before === undefined || NULL_SHA.test(before) ? undefined : before, head: after };
  }
  return { base: undefined, head: headSha };
}

/** The commits between the two ends, or the whole history of the head when there is no base. */
function rangeOf({ base, head }: Revisions): string {
  return base === undefined ? head : `${base}..${head}`;
}

/**
 * The revisions a CI run must check: a pull request's own commits, a push's new commits,
 * or, for a new branch and any other event, the whole history of the head commit.
 */
export function rangeFromGithubEvent(eventName: string, payload: unknown, headSha: string): string {
  return rangeOf(revisionsFromGithubEvent(eventName, payload, headSha));
}

export type ReadText = (path: string) => Promise<string>;

/** Reads the event's ends from the GitHub Actions environment (GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_SHA). */
export async function revisionsFromGithubEnv(
  env: Readonly<Record<string, string | undefined>>,
  readText: ReadText,
): Promise<Revisions> {
  const eventName = env['GITHUB_EVENT_NAME'];
  const eventPath = env['GITHUB_EVENT_PATH'];
  const headSha = env['GITHUB_SHA'];
  if (!eventName || !eventPath || !headSha) {
    throw new Error('--github needs GITHUB_EVENT_NAME, GITHUB_EVENT_PATH and GITHUB_SHA');
  }
  const payload: unknown = JSON.parse(await readText(eventPath));
  return revisionsFromGithubEvent(eventName, payload, headSha);
}

/** Reads the event's range from the GitHub Actions environment (GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_SHA). */
export async function rangeFromGithubEnv(
  env: Readonly<Record<string, string | undefined>>,
  readText: ReadText,
): Promise<string> {
  return rangeOf(await revisionsFromGithubEnv(env, readText));
}
