import { join } from 'node:path';
import { isRecord, stringField } from "../core/guards.js";
import { parseObject, recordVersion, VERSION_FIELD, writableObject } from "../core/jsonl.js";
import { MERGE_FORMAT, mergeRecordOf, parseMergeRecord } from "./merge-log.js";
/** The pending merge file's format; a field added to it raises this. */
export const PENDING_MERGE_FORMAT = 2;
/** The format before `merge`: still read, with no merges row. */
const NO_ROW_FORMAT = 1;
/** The branch's file; git refuses `* ? :` and the like in branch names, so the encoded name is a file name on every OS. */
export function pendingMergePath(places, repo, branch) {
    return join(places.pendingMerges, `${encodeURIComponent(`${repo}/${branch}`)}.json`);
}
/** The file's text for a pending merge. */
export function formatPendingMerge(pending) {
    const { session, repo, branch, head, base, since, note, merge } = pending;
    const row = merge === undefined ? null : mergeRecordOf(merge);
    return `${JSON.stringify({ [VERSION_FIELD]: PENDING_MERGE_FORMAT, session, repo, branch, head, base, since, note, merge: row }, null, 2)}\n`;
}
function rowOf(value, version) {
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
export function parsePendingMerge(text) {
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
export async function readPendingMerge(files, places, repo, branch) {
    const text = await files.read(pendingMergePath(places, repo, branch));
    const pending = text === undefined ? undefined : parsePendingMerge(text);
    return pending?.repo === repo && pending.branch === branch ? pending : undefined;
}
/** Writes the branch's pending merge; one a newer teamrig wrote is refused (`NewerDataError`), never overwritten. */
export async function writePendingMerge(files, places, pending) {
    const path = pendingMergePath(places, pending.repo, pending.branch);
    writableObject(path, await files.read(path), PENDING_MERGE_FORMAT);
    await files.write(path, formatPendingMerge(pending));
}
/** Removes the branch's pending merge; none is no error. */
export async function removePendingMerge(files, places, repo, branch) {
    await files.remove(pendingMergePath(places, repo, branch));
}
