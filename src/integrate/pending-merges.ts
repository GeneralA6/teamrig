import { join } from 'node:path';
import type { CoordinatorPlaces } from '../coordinator/places.ts';
import type { Files } from '../core/files.ts';
import { isRecord, stringField } from '../core/guards.ts';

/**
 * A branch whose repository's merge command said it waits (exit 75), say on a pull request's checks or review: one
 * JSON file per branch in the coordinator's `pending-merges` folder, written and removed under the host lock. The next
 * integrate of that branch, still at that commit, finishes it without running the command again once origin's default
 * branch holds it.
 */
export interface PendingMerge {
  readonly session: string;
  readonly repo: string;
  readonly branch: string;
  /** The rebased commit the merge command was given. */
  readonly head: string;
  /** Origin's default branch when the command ran: the merge is looked for in the commits after it. */
  readonly base: string;
  /** When the first run of the merge command for this branch started, as an ISO time. */
  readonly since: string;
  /** The command's last output line, such as the pull request's address; empty when it printed none. */
  readonly note: string;
}

/** The branch's file; git refuses `* ? :` and the like in branch names, so the encoded name is a file name on every OS. */
export function pendingMergePath(places: Pick<CoordinatorPlaces, 'pendingMerges'>, repo: string, branch: string): string {
  return join(places.pendingMerges, `${encodeURIComponent(`${repo}/${branch}`)}.json`);
}

function pendingMergeOf(value: unknown): PendingMerge | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const session = stringField(value, 'session');
  const repo = stringField(value, 'repo');
  const branch = stringField(value, 'branch');
  const head = stringField(value, 'head');
  const base = stringField(value, 'base');
  const since = stringField(value, 'since');
  const note = stringField(value, 'note');
  if (session === undefined || repo === undefined || branch === undefined || head === undefined || base === undefined || since === undefined || note === undefined) {
    return undefined;
  }
  return { session, repo, branch, head, base, since, note };
}

/** The branch's pending merge; undefined when there is none, or its file is unreadable or names another branch. */
export async function readPendingMerge(files: Pick<Files, 'read'>, places: Pick<CoordinatorPlaces, 'pendingMerges'>, repo: string, branch: string): Promise<PendingMerge | undefined> {
  const text = await files.read(pendingMergePath(places, repo, branch));
  if (text === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const pending = pendingMergeOf(parsed);
  return pending?.repo === repo && pending.branch === branch ? pending : undefined;
}

export async function writePendingMerge(files: Pick<Files, 'write'>, places: Pick<CoordinatorPlaces, 'pendingMerges'>, pending: PendingMerge): Promise<void> {
  await files.write(pendingMergePath(places, pending.repo, pending.branch), `${JSON.stringify(pending, null, 2)}\n`);
}

/** Removes the branch's pending merge; none is no error. */
export async function removePendingMerge(files: Pick<Files, 'remove'>, places: Pick<CoordinatorPlaces, 'pendingMerges'>, repo: string, branch: string): Promise<void> {
  await files.remove(pendingMergePath(places, repo, branch));
}
