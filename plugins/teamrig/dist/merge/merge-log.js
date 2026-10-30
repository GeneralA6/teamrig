import { isNonNegativeInteger, isStringArray, stringField } from "../core/guards.js";
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { isReviewClearance } from "./review-gate-step.js";
import { isSelfMergeGate } from "./self-merge.js";
/**
 * The team's append-only log of what `teamrig merge` merged under `pushGuard.pushToProtected: gated` (T800 §2.1,
 * T858), `merges.jsonl` in the delivery folder, oldest first: one record a merged change, whether every gate held
 * or a leader approved the gates it missed, so the meeting digest and an audit read what merged with no click.
 */
/** The format of the log's records; a newer one is skipped on read and refuses a write. */
export const MERGE_FORMAT = 1;
/** One landed change as the log's JSON record. */
export function mergeRecordOf(record) {
    const { at, session, repo, branch, task, base, head, tree, files, lines, checks, review } = record;
    const landed = { [VERSION_FIELD]: MERGE_FORMAT, at, session, repo, branch, task: task ?? null, base, head, tree, files, lines, checks, review, route: record.route };
    return record.route === 'self' ? landed : { ...landed, missed: record.missed, approvedBy: record.approvedBy };
}
const isGateList = (value) => Array.isArray(value) && value.length > 0 && value.every(isSelfMergeGate);
const TEXT_FIELDS = ['at', 'session', 'repo', 'branch', 'base', 'head', 'tree'];
/** One record as a landed change; undefined when it is damaged. */
export function parseMergeRecord(record) {
    const [at, session, repo, branch, base, head, tree] = TEXT_FIELDS.map((key) => stringField(record, key));
    const { task, files, lines, checks, review, route, missed } = record;
    const approvedBy = stringField(record, 'approvedBy');
    if (at === undefined ||
        !Number.isFinite(Date.parse(at)) ||
        session === undefined ||
        repo === undefined ||
        branch === undefined ||
        base === undefined ||
        head === undefined ||
        tree === undefined ||
        (task !== null && typeof task !== 'string') ||
        !isNonNegativeInteger(files) ||
        !isNonNegativeInteger(lines) ||
        !isStringArray(checks) ||
        !isReviewClearance(review)) {
        return undefined;
    }
    const landed = { at, session, repo, branch, task: task ?? undefined, base, head, tree, files, lines, checks, review };
    if (route === 'self') {
        return { ...landed, route };
    }
    return route === 'approved' && isGateList(missed) && approvedBy !== undefined ? { ...landed, route, missed, approvedBy } : undefined;
}
/** The team's append-only log of landed changes, oldest first. */
export class MergeLog {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    async read() {
        const parse = parseJsonl((await this.files.read(this.path)) ?? '');
        const records = [];
        for (const { record, version } of parse.records) {
            const parsed = version === MERGE_FORMAT ? parseMergeRecord(record) : undefined;
            if (parsed !== undefined) {
                records.push(parsed);
            }
        }
        return { records, skipped: parse.unreadable + parse.records.length - records.length };
    }
    /** One whole line in one append; refused beside records from a newer teamrig. */
    async append(record) {
        const text = (await this.files.read(this.path)) ?? '';
        assertWritable(this.path, parseJsonl(text), MERGE_FORMAT);
        const separator = text === '' || text.endsWith('\n') ? '' : '\n';
        await this.files.append(this.path, `${separator}${toJsonlLine(mergeRecordOf(record))}`);
    }
}
