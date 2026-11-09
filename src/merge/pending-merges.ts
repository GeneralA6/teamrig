import { join } from 'node:path';
import type { DeliveryPlaces } from '../delivery/places.ts';
import type { Files } from '../core/files.ts';
import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { parseObject, recordVersion, VERSION_FIELD, writableObject } from '../core/jsonl.ts';
import { MERGE_FORMAT, mergeRecordOf, parseMergeRecord, type MergeRecord } from './merge-log.ts';

/**
 * A branch whose repository's merge command said it waits (exit 75), say on a pull request's checks or review: one
 * file per branch in the delivery folder's `pending-merges` folder, written and removed under the host lock. The next
 * `teamrig merge` of that branch, still at that commit, finishes it without running the command again once the merge remote's
 * default branch holds it. The format, one JSON object:
 *
 * - `v`: `PENDING_MERGE_FORMAT`;
 * - `session`, `repo`, `branch`: who ran the command, and for which repository's branch;
 * - `head`, `base`: the rebased commit the command was given, and the merge remote's default branch when it ran;
 * - `since`: when the first run of the command for this branch started, ISO 8601 UTC;
 * - `note`: the command's last output line, such as the pull request's address; empty when it printed none;
 * - `merge`: since format 2, the merges row (`merge-log.ts`, with its own `v`) of the change the self-merge step
 *   weighed before the command ran, which the run that finds it merged logs; null when the step weighed nothing.
 *   A format 1 file reads with none, so a merge left waiting across an upgrade still finishes.
 */
export interface PendingMerge {
  readonly session: string;
  readonly repo: string;
  readonly branch: string;
  /** The rebased commit the merge command was given. */
  readonly head: string;
  /** The merge remote's default branch when the command ran: the merge is looked for in the commits after it. */
  readonly base: string;
  /** When the first run of the merge command for this branch started, as an ISO time. */
  readonly since: string;
  /** The command's last output line, such as the pull request's address; empty when it printed none. */
  readonly note: string;
  /**
   * The merges row the self-merge step weighed for `head`, logged by the run that finds it merged, with `at` set to
   * then (T1514); undefined when the push guard is not gated, so the step weighed nothing.
   */
  readonly merge: MergeRecord | undefined;
}

/** The pending merge file's format; a field added to it raises this. */
export const PENDING_MERGE_FORMAT = 2;

/** The format before `merge`: still read, with no merges row. */
const NO_ROW_FORMAT = 1;

/** The branch's file; git refuses `* ? :` and the like in branch names, so the encoded name is a file name on every OS. */
export function pendingMergePath(places: Pick<DeliveryPlaces, 'pendingMerges'>, repo: string, branch: string): string {
  return join(places.pendingMerges, `${encodeURIComponent(`${repo}/${branch}`)}.json`);
}

/** The file's text for a pending merge. */
export function formatPendingMerge(pending: PendingMerge): string {
  const { session, repo, branch, head, base, since, note, merge } = pending;
  const row = merge === undefined ? null : mergeRecordOf(merge);
  return `${JSON.stringify({ [VERSION_FIELD]: PENDING_MERGE_FORMAT, session, repo, branch, head, base, since, note, merge: row }, null, 2)}\n`;
}

/** What a file's `merge` field holds: a row or none, else damage, a row of a merges format it cannot read among it. */
type RowRead = { readonly kind: 'read'; readonly merge: MergeRecord | undefined } | { readonly kind: 'damaged' };

function rowOf(value: JsonRecord, version: number): RowRead {
  const { merge } = value;
  if (version === NO_ROW_FORMAT || merge === null) {
    return { kind: 'read', merge: undefined };
  }
  const parsed = isRecord(merge) && recordVersion(merge) === MERGE_FORMAT ? parseMergeRecord(merge) : undefined;
  return parsed === undefined ? { kind: 'damaged' } : { kind: 'read', merge: parsed };
}

/**
 * The pending merge a file's text holds; undefined for damaged text, a missing or damaged field or a format it cannot
 * read, so the next run gives the merge command the change again.
 */
export function parsePendingMerge(text: string): PendingMerge | undefined {
  const value = parseObject(text.trim());
  const version = value === undefined ? undefined : recordVersion(value);
  if (value === undefined || (version !== PENDING_MERGE_FORMAT && version !== NO_ROW_FORMAT)) {
    return undefined;
  }
  const row = rowOf(value, version);
  const session = stringField(value, 'session');
  const repo = stringField(value, 'repo');
  const branch = stringField(value, 'branch');
  const head = stringField(value, 'head');
  const base = stringField(value, 'base');
  const since = stringField(value, 'since');
  const note = stringField(value, 'note');
  if (row.kind === 'damaged' || session === undefined || repo === undefined || branch === undefined || head === undefined || base === undefined || since === undefined || note === undefined) {
    return undefined;
  }
  return { session, repo, branch, head, base, since, note, merge: row.merge };
}

/** The branch's pending merge; undefined when there is none, or its file is unreadable or names another branch. */
export async function readPendingMerge(files: Pick<Files, 'read'>, places: Pick<DeliveryPlaces, 'pendingMerges'>, repo: string, branch: string): Promise<PendingMerge | undefined> {
  const text = await files.read(pendingMergePath(places, repo, branch));
  const pending = text === undefined ? undefined : parsePendingMerge(text);
  return pending?.repo === repo && pending.branch === branch ? pending : undefined;
}

/** Writes the branch's pending merge; one a newer teamrig wrote is refused (`NewerDataError`), never overwritten. */
export async function writePendingMerge(files: Pick<Files, 'read' | 'write'>, places: Pick<DeliveryPlaces, 'pendingMerges'>, pending: PendingMerge): Promise<void> {
  const path = pendingMergePath(places, pending.repo, pending.branch);
  writableObject(path, await files.read(path), PENDING_MERGE_FORMAT);
  await files.write(path, formatPendingMerge(pending));
}

/** Removes the branch's pending merge; none is no error. */
export async function removePendingMerge(files: Pick<Files, 'remove'>, places: Pick<DeliveryPlaces, 'pendingMerges'>, repo: string, branch: string): Promise<void> {
  await files.remove(pendingMergePath(places, repo, branch));
}
