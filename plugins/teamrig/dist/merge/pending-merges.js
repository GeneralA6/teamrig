import { join } from 'node:path';
import { stringField } from "../core/guards.js";
import { parseObject, recordVersion, VERSION_FIELD, writableObject } from "../core/jsonl.js";
/** The pending merge file's format; a field added to it raises this. */
export const PENDING_MERGE_FORMAT = 1;
/** The branch's file; git refuses `* ? :` and the like in branch names, so the encoded name is a file name on every OS. */
export function pendingMergePath(places, repo, branch) {
    return join(places.pendingMerges, `${encodeURIComponent(`${repo}/${branch}`)}.json`);
}
/** The file's text for a pending merge. */
export function formatPendingMerge(pending) {
    const { session, repo, branch, head, base, since, note } = pending;
    return `${JSON.stringify({ [VERSION_FIELD]: PENDING_MERGE_FORMAT, session, repo, branch, head, base, since, note }, null, 2)}\n`;
}
/** The pending merge a file's text holds; undefined for damaged text, a missing field or a format it cannot read. */
export function parsePendingMerge(text) {
    const value = parseObject(text.trim());
    if (value === undefined || recordVersion(value) !== PENDING_MERGE_FORMAT) {
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
