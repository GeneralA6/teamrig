import { isNonNegativeInteger, isRecord } from "../core/guards.js";
import { parseObject, recordVersion, toJsonlLine } from "../core/jsonl.js";
import { canonicalJson, sha256Hex } from "./digest.js";
import { readStoredRequest, requestSha256 } from "./request.js";
/** The audit line format this code writes and reads. */
export const AUDIT_VERSION = 1;
/** The `prev` of a log's first line: no line came before it. */
export const GENESIS_HASH = '0'.repeat(64);
const SHA256 = /^[0-9a-f]{64}$/u;
/** A request's id: R1, R2, ... in the order the log holds them. */
export const REQUEST_ID = /^R[1-9]\d*$/u;
export const REVIEW_DECISIONS = ['approved', 'refused', 'escalated'];
export const EMPTY_AUDIT = { records: new Map(), seq: 0, lastHash: GENESIS_HASH };
/** Thrown before an append when the log's chain is broken or newer than this code: nothing more is written to it. */
export class AuditChainError extends Error {
    file;
    line;
    reason;
    constructor(file, line, reason) {
        super(`${file} line ${line}: ${reason}`);
        this.name = 'AuditChainError';
        this.file = file;
        this.line = line;
        this.reason = reason;
    }
}
function requestIdAfter(count) {
    return `R${count + 1}`;
}
/** The id the next request gets: R1, R2, … in the order the log holds them. */
export function nextRequestId(state) {
    return requestIdAfter(state.records.size);
}
function isSha256(value) {
    return typeof value === 'string' && SHA256.test(value);
}
function isRequestId(value) {
    return typeof value === 'string' && REQUEST_ID.test(value);
}
function isInstant(value) {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
function isText(value) {
    return typeof value === 'string' && value.trim() !== '';
}
function isExitCode(value) {
    return value === null || (typeof value === 'number' && Number.isInteger(value));
}
function parseOutcome(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const { exitCode, timedOut, outputSha256, outputFile, tail } = value;
    if (isExitCode(exitCode) && typeof timedOut === 'boolean' && isSha256(outputSha256) && isText(outputFile) && typeof tail === 'string') {
        return { exitCode, timedOut, outputSha256, outputFile, tail };
    }
    return undefined;
}
/** An approval's expiry and nonce, or both null for any other decision; undefined when they do not fit the decision. */
function grantOf(decision, expiresAt, nonce) {
    if (decision !== 'approved') {
        return expiresAt === null && nonce === null ? { expiresAt: null, nonce: null } : undefined;
    }
    return isInstant(expiresAt) && isText(nonce) ? { expiresAt, nonce } : undefined;
}
function parseReview(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const { id, reviewer, ownerGated, note, dryRunSha256, scheme, signature } = value;
    const decision = REVIEW_DECISIONS.find((candidate) => candidate === value['decision']);
    const reviewed = value['requestSha256'];
    const grant = decision === undefined ? undefined : grantOf(decision, value['expiresAt'], value['nonce']);
    if (decision === undefined ||
        grant === undefined ||
        !isRequestId(id) ||
        !isText(reviewer) ||
        typeof ownerGated !== 'boolean' ||
        typeof note !== 'string' ||
        !isSha256(reviewed) ||
        !(dryRunSha256 === null || isSha256(dryRunSha256)) ||
        !isText(scheme) ||
        typeof signature !== 'string') {
        return undefined;
    }
    return { id, decision, reviewer, ownerGated, note, requestSha256: reviewed, dryRunSha256, ...grant, scheme, signature };
}
function parseEvent(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const { type, id } = value;
    if (type === 'request') {
        const request = readStoredRequest(value['request']);
        return request === undefined ? undefined : { type, request };
    }
    if (type === 'review') {
        const review = parseReview(value['review']);
        return review === undefined ? undefined : { type, review };
    }
    if (!isRequestId(id)) {
        return undefined;
    }
    if (type === 'run-start') {
        const nonce = value['nonce'];
        return isText(nonce) ? { type, id, nonce } : undefined;
    }
    const outcome = parseOutcome(value['outcome']);
    if (outcome === undefined) {
        return undefined;
    }
    if (type === 'dry-run') {
        return { type, id, outcome };
    }
    return type === 'run-end' ? { type, id, outcome } : undefined;
}
function parseLine(record) {
    const { v, seq, at, prev, hash } = record;
    const event = parseEvent(record['event']);
    if (v === AUDIT_VERSION && isNonNegativeInteger(seq) && seq > 0 && isInstant(at) && isSha256(prev) && isSha256(hash) && event !== undefined) {
        return { v, seq, at, event, prev, hash };
    }
    return undefined;
}
/** The record after a review, or why the review cannot follow what the log already holds. */
function reviewed(record, review, at) {
    const { id } = review;
    if (record.review !== undefined) {
        return `${id} is already ${record.review.decision}`;
    }
    if (review.requestSha256 !== requestSha256(record.request)) {
        return `${id}'s review is of a different request (its SHA-256 differs)`;
    }
    if (review.dryRunSha256 !== (record.dryRun?.outputSha256 ?? null)) {
        return `${id}'s review names a different dry run than the one the executor ran`;
    }
    if (review.decision === 'escalated') {
        return record.escalation === undefined ? { ...record, escalation: { ...review, at } } : `${id} is already escalated to the owner`;
    }
    if (review.decision === 'approved' && record.request.dryRunArgv !== null && record.dryRun === undefined) {
        return `${id}'s dry run has not run yet: the reviewer approves what the executor's dry run showed`;
    }
    return { ...record, review: { ...review, at } };
}
/** The record after a run starts, or why it may not: no approval, a burnt or foreign nonce, outside its time. */
function started(record, nonce, at) {
    const { id, window } = record.request;
    const { review } = record;
    if (review === undefined || review.decision !== 'approved' || review.expiresAt === null) {
        return `${id} has no approval`;
    }
    if (record.runStart !== undefined) {
        return `${id} already ran at ${record.runStart.at}: an approval is single use, so a new run needs a new request`;
    }
    if (nonce !== review.nonce) {
        return `${id}'s run names a nonce its approval did not issue`;
    }
    if (Date.parse(at) > Date.parse(review.expiresAt)) {
        return `${id}'s approval expired at ${review.expiresAt}`;
    }
    if (window !== null && Date.parse(at) < Date.parse(window.runAfter)) {
        return `${id} may not run before ${window.runAfter}`;
    }
    return { ...record, runStart: { nonce, at } };
}
/** The record after one more of its events, or why that event cannot follow what the log already holds. */
function nextRecord(record, event, at) {
    const { id } = record.request;
    switch (event.type) {
        case 'dry-run':
            if (record.request.dryRunArgv === null) {
                return `${id} has no dry-run form`;
            }
            if (record.dryRun !== undefined) {
                return `${id} already has a dry run`;
            }
            if (record.escalation !== undefined || record.review !== undefined) {
                return `${id} is already reviewed: its dry run comes before the review`;
            }
            return { ...record, dryRun: { ...event.outcome, at } };
        case 'review':
            return reviewed(record, event.review, at);
        case 'run-start':
            return started(record, event.nonce, at);
        case 'run-end':
            if (record.runStart === undefined) {
                return `${id} has not started`;
            }
            return record.runEnd === undefined ? { ...record, runEnd: { ...event.outcome, at } } : `${id} already ended`;
    }
}
/**
 * Folds lines into the state in order, checking each one's chain link, hash and place in its request's life. It
 * owns its map, so a whole log is read with one copy, not one per line.
 */
class AuditFold {
    records;
    seq;
    lastHash;
    constructor(from) {
        this.records = new Map(from.records);
        this.seq = from.seq;
        this.lastHash = from.lastHash;
    }
    /** Takes one raw line: the line read, or why it breaks the log (nothing is taken then). */
    take(raw) {
        const record = parseObject(raw);
        if (record === undefined) {
            return 'not one JSON object: a torn or edited line';
        }
        const version = recordVersion(record);
        if (version !== undefined && version > AUDIT_VERSION) {
            return `format v${version}; this teamrig reads v${AUDIT_VERSION}: update teamrig`;
        }
        const line = parseLine(record);
        if (line === undefined) {
            return 'not an audit line: its v, seq, at, event, prev or hash does not fit';
        }
        if (line.seq !== this.seq + 1) {
            return `seq ${line.seq} follows seq ${this.seq}: a line is missing or repeated`;
        }
        if (line.prev !== this.lastHash) {
            return 'prev is not the hash of the line before: the log was cut or reordered';
        }
        const { hash, ...body } = record;
        if (sha256Hex(canonicalJson(body)) !== hash) {
            return 'its hash does not match its content: the line was edited after it was written';
        }
        const reason = this.apply(line.event, line.at);
        if (reason !== undefined) {
            return reason;
        }
        this.seq = line.seq;
        this.lastHash = line.hash;
        return line;
    }
    state() {
        return { records: new Map(this.records), seq: this.seq, lastHash: this.lastHash };
    }
    /** Applies an event, or gives why it cannot follow what the log holds. */
    apply(event, at) {
        if (event.type === 'request') {
            const expected = requestIdAfter(this.records.size);
            if (event.request.id !== expected) {
                return `the next request is ${expected}, not ${event.request.id}`;
            }
            this.records.set(expected, { request: event.request, dryRun: undefined, escalation: undefined, review: undefined, runStart: undefined, runEnd: undefined });
            return undefined;
        }
        const id = event.type === 'review' ? event.review.id : event.id;
        const record = this.records.get(id);
        if (record === undefined) {
            return `a ${event.type} for ${id}, which no request created`;
        }
        const next = nextRecord(record, event, at);
        if (typeof next === 'string') {
            return next;
        }
        this.records.set(id, next);
        return undefined;
    }
}
/** Reads a whole log's text, checking its chain from the first line; blank lines carry nothing and are skipped. */
export function readAudit(text) {
    const fold = new AuditFold(EMPTY_AUDIT);
    for (const [index, line] of text.split('\n').entries()) {
        const raw = line.endsWith('\r') ? line.slice(0, -1) : line;
        const taken = raw.trim() === '' ? undefined : fold.take(raw);
        if (typeof taken === 'string') {
            return { ok: false, line: index + 1, reason: taken };
        }
    }
    return { ok: true, state: fold.state() };
}
/**
 * The executor's hash-chained, append-only log of privileged commands (spec §10): every request, dry run, review and
 * run is one line, and the state of each request is derived from the lines alone. Appends hold the lock, so two
 * runs of one approval cannot both burn its nonce. Monthly rotation and sealing come later; tens of lines a day,
 * not tied to symbols or models.
 */
export class AuditLog {
    path;
    files;
    lock;
    clock;
    constructor(path, files, lock, clock) {
        this.path = path;
        this.files = files;
        this.lock = lock;
        this.clock = clock;
    }
    async read() {
        return readAudit((await this.files.read(this.path)) ?? '');
    }
    /**
     * Appends the event `decide` picks from the current state, under the lock. `decide` is synchronous so the lock is
     * held for milliseconds: checks that take longer (git, the dry run) happen before the call. The line is read back
     * and checked like any other before it is written, so this never writes a line the log would refuse. Throws
     * AuditChainError when the log is broken, and writes nothing more to it.
     */
    async append(decide) {
        return this.lock.run(async () => {
            const read = await this.read();
            if (!read.ok) {
                throw new AuditChainError(this.path, read.line, read.reason);
            }
            const decision = decide(read.state);
            if ('refusal' in decision) {
                return { ok: false, refusal: decision.refusal };
            }
            const body = { v: AUDIT_VERSION, seq: read.state.seq + 1, at: new Date(this.clock.now()).toISOString(), event: decision, prev: read.state.lastHash };
            const text = toJsonlLine({ ...body, hash: sha256Hex(canonicalJson(body)) });
            const fold = new AuditFold(read.state);
            const line = fold.take(text.trimEnd());
            if (typeof line === 'string') {
                return { ok: false, refusal: line };
            }
            await this.files.append(this.path, text);
            return { ok: true, line, state: fold.state() };
        });
    }
}
