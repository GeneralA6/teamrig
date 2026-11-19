import { isRecord, recordField, stringField, type JsonRecord } from '../lib/guards.ts';

const NULL_SHA = /^0+$/;

/** The two ends of a CI run: the commit before the change (none for a new branch) and its head. */
export interface Revisions {
  readonly base: string | undefined;
  readonly head: string;
}

/**
 * The ends a CI run must compare: a pull request's base and head, a merge queue group's base (the branch it lands
 * on) and head (its queued pull requests' commits on top, T3386), a push's commit before and after, or, for a new
 * branch and any other event, the head commit alone.
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
  if (eventName === 'merge_group') {
    // Without both ends the gates would read the head's whole history, every commit main ever took: refuse instead.
    const group = recordField(event, 'merge_group') ?? {};
    const base = stringField(group, 'base_sha');
    const head = stringField(group, 'head_sha');
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
 * The revisions a CI run must check: a pull request's own commits, a merge queue group's queued commits, a push's
 * new commits, or, for a new branch and any other event, the whole history of the head commit.
 */
export function rangeFromGithubEvent(eventName: string, payload: unknown, headSha: string): string {
  return rangeOf(revisionsFromGithubEvent(eventName, payload, headSha));
}

export type ReadText = (path: string) => Promise<string>;

/** A GitHub Actions event as the runner hands it over: its name, its payload and the sha the run checked out. */
export interface GithubEvent {
  readonly name: string;
  readonly payload: unknown;
  readonly headSha: string;
}

/** Reads the event from the GitHub Actions environment (GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_SHA). */
export async function githubEventFromEnv(env: Readonly<Record<string, string | undefined>>, readText: ReadText): Promise<GithubEvent> {
  const name = env['GITHUB_EVENT_NAME'];
  const eventPath = env['GITHUB_EVENT_PATH'];
  const headSha = env['GITHUB_SHA'];
  if (!name || !eventPath || !headSha) {
    throw new Error('--github needs GITHUB_EVENT_NAME, GITHUB_EVENT_PATH and GITHUB_SHA');
  }
  const payload: unknown = JSON.parse(await readText(eventPath));
  return { name, payload, headSha };
}

/** Reads the event's ends from the GitHub Actions environment (GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_SHA). */
export async function revisionsFromGithubEnv(
  env: Readonly<Record<string, string | undefined>>,
  readText: ReadText,
): Promise<Revisions> {
  const event = await githubEventFromEnv(env, readText);
  return revisionsFromGithubEvent(event.name, event.payload, event.headSha);
}

/** What a fork pull request's head repository is called when GitHub no longer has it. */
export const DELETED_FORK = 'a deleted fork';

const repoNameOf = (side: JsonRecord): string | undefined => stringField(recordField(side, 'repo') ?? {}, 'full_name');

/**
 * The fork a pull request comes from: its head repository's full name when that is not the base repository
 * (DELETED_FORK when GitHub no longer has it); null for a pull request from a branch of the repository itself and
 * for any other event. A contributor's fork pull request is merged as it is, and the maintainer's release pull
 * request after the merge raises the plugin version and rebuilds the dist (tools/ship/merge-pr.ts).
 */
export function forkOfPull({ name, payload }: GithubEvent): string | null {
  // Only `pull_request`: a `pull_request_target` run checks out the base, not the merge, so the gates must never skip
  // on it (ci.yml uses none; security verdict T3052 N2).
  if (name !== 'pull_request') {
    return null;
  }
  const pullRequest = recordField(isRecord(payload) ? payload : {}, 'pull_request') ?? {};
  const base = repoNameOf(recordField(pullRequest, 'base') ?? {});
  if (base === undefined) {
    throw new Error(`${name} event without the base repository's name`);
  }
  const head = recordField(pullRequest, 'head') ?? {};
  // GitHub sends a null head repository once the fork is deleted.
  const fork = recordField(head, 'repo') === undefined ? DELETED_FORK : repoNameOf(head);
  if (fork === undefined) {
    throw new Error(`${name} event without the head repository's name`);
  }
  return fork === base ? null : fork;
}

/** Reads the event's range from the GitHub Actions environment (GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_SHA). */
export async function rangeFromGithubEnv(
  env: Readonly<Record<string, string | undefined>>,
  readText: ReadText,
): Promise<string> {
  return rangeOf(await revisionsFromGithubEnv(env, readText));
}
