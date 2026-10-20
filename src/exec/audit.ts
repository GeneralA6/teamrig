import type { Files } from '../core/files.ts';
import { isNonNegativeInteger, isRecord, type JsonRecord } from '../core/guards.ts';
import { parseObject, recordVersion, toJsonlLine } from '../core/jsonl.ts';
import type { Clock, Mutex } from '../core/lock.ts';
import { canonicalJson, sha256Hex } from './digest.ts';
import { readStoredRequest, requestSha256, type ExecRequest } from './request.ts';

/** The audit line format this code writes and reads. */
export const AUDIT_VERSION = 1;

/** The `prev` of a log's first line: no line came before it. */
export const GENESIS_HASH = '0'.repeat(64);

const SHA256 = /^[0-9a-f]{64}$/u;
/** A request's id: R1, R2, ... in the order the log holds them. */
export const REQUEST_ID = /^R[1-9]\d*$/u;

/** How a process the executor started ended: the dry run, or the approved run. */
export interface RunOutcome {
  /** Null when the process ended without one: killed at its max runtime, or by a signal. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** The SHA-256 of the full output as kept (redacted), so the file can be checked against the log later. */
  readonly outputSha256: string;
  readonly outputFile: string;
  /** The output's last lines, bounded: what the reviewer reads, and the counts the command printed. */
  readonly tail: string;
}

export const REVIEW_DECISIONS = ['approved', 'refused', 'escalated'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** A reviewer's decision on a request (spec §7-§9); `escalated` hands an owner-gated request on to the owner. */
export interface Review {
  readonly id: string;
  readonly decision: ReviewDecision;
  /** The session that decided, or the owner. */
  readonly reviewer: string;
  /** Whether the request is owner-gated as reviewed: the requester's flag, or the reviewer's escalation. */
  readonly ownerGated: boolean;
  /** The reason; a refusal's names the safe alternative. */
  readonly note: string;
  /** The SHA-256 of the request as reviewed. */
  readonly requestSha256: string;
  /** The SHA-256 of the dry-run output the reviewer read; null when the request has no dry run. */
  readonly dryRunSha256: string | null;
  /** An approval's last instant; null for a refusal or an escalation. */
  readonly expiresAt: string | null;
  /** An approval's single-use nonce, which the run burns; null for a refusal or an escalation. */
  readonly nonce: string | null;
  /** How the approval is signed (`unsigned` in phase 1) and the signature over what it binds. */
  readonly scheme: string;
  readonly signature: string;
}

export type AuditEvent =
  | { readonly type: 'request'; readonly request: ExecRequest }
  | { readonly type: 'dry-run'; readonly id: string; readonly outcome: RunOutcome }
  | { readonly type: 'review'; readonly review: Review }
  | { readonly type: 'run-start'; readonly id: string; readonly nonce: string }
  | { readonly type: 'run-end'; readonly id: string; readonly outcome: RunOutcome };

type RecordEvent = Exclude<AuditEvent, { readonly type: 'request' }>;

/** One line of the log: an event, numbered, timed by the executor's clock, and chained to the line before it. */
export interface AuditLine {
  readonly v: number;
  readonly seq: number;
  readonly at: string;
  readonly event: AuditEvent;
  /** The `hash` of the line before; GENESIS_HASH on the first. */
  readonly prev: string;
  /** The SHA-256 of the line's canonical JSON without this field. */
  readonly hash: string;
}

/** A value with the instant of the line that recorded it. */
export type Stamped<T> = T & { readonly at: string };

/** Everything the log holds about one request, in the order it happens. */
export interface RequestRecord {
  readonly request: ExecRequest;
  readonly dryRun: Stamped<RunOutcome> | undefined;
  readonly escalation: Stamped<Review> | undefined;
  /** The settling review: an approval or a refusal. */
  readonly review: Stamped<Review> | undefined;
  readonly runStart: Stamped<{ readonly nonce: string }> | undefined;
  readonly runEnd: Stamped<RunOutcome> | undefined;
}

/** What a whole, unbroken log says: every request's record, and where the chain ends. */
export interface AuditState {
  readonly records: ReadonlyMap<string, RequestRecord>;
  readonly seq: number;
  readonly lastHash: string;
}

export const EMPTY_AUDIT: AuditState = { records: new Map(), seq: 0, lastHash: GENESIS_HASH };

/** The log read and its chain checked: the state, or the first line that breaks it and why. */
export type AuditRead = { readonly ok: true; readonly state: AuditState } | { readonly ok: false; readonly line: number; readonly reason: string };

/** What a caller decides from the state under the lock: the event to append, or why nothing is appended. */
export type AuditDecision = AuditEvent | { readonly refusal: string };

export type AuditAppend =
  | { readonly ok: true; readonly line: AuditLine; readonly state: AuditState }
  | { readonly ok: false; readonly refusal: string };

/** Thrown before an append when the log's chain is broken or newer than this code: nothing more is written to it. */
export class AuditChainError extends Error {
  readonly file: string;
  readonly line: number;
  readonly reason: string;

  constructor(file: string, line: number, reason: string) {
    super(`${file} line ${line}: ${reason}`);
    this.name = 'AuditChainError';
    this.file = file;
    this.line = line;
    this.reason = reason;
  }
}

function requestIdAfter(count: number): string {
  return `R${count + 1}`;
}

/** The id the next request gets: R1, R2, … in the order the log holds them. */
export function nextRequestId(state: AuditState): string {
  return requestIdAfter(state.records.size);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isExitCode(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isInteger(value));
}

function parseOutcome(value: unknown): RunOutcome | undefined {
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
function grantOf(decision: ReviewDecision, expiresAt: unknown, nonce: unknown): Pick<Review, 'expiresAt' | 'nonce'> | undefined {
  if (decision !== 'approved') {
    return expiresAt === null && nonce === null ? { expiresAt: null, nonce: null } : undefined;
  }
  return isInstant(expiresAt) && isText(nonce) ? { expiresAt, nonce } : undefined;
}

function parseReview(value: unknown): Review | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { id, reviewer, ownerGated, note, dryRunSha256, scheme, signature } = value;
  const decision = REVIEW_DECISIONS.find((candidate) => candidate === value['decision']);
  const reviewed = value['requestSha256'];
  const grant = decision === undefined ? undefined : grantOf(decision, value['expiresAt'], value['nonce']);
  if (
    decision === undefined ||
    grant === undefined ||
    !isRequestId(id) ||
    !isText(reviewer) ||
    typeof ownerGated !== 'boolean' ||
    typeof note !== 'string' ||
    !isSha256(reviewed) ||
    !(dryRunSha256 === null || isSha256(dryRunSha256)) ||
    !isText(scheme) ||
    typeof signature !== 'string'
  ) {
    return undefined;
  }
  return { id, decision, reviewer, ownerGated, note, requestSha256: reviewed, dryRunSha256, ...grant, scheme, signature };
}

function parseEvent(value: unknown): AuditEvent | undefined {
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

function parseLine(record: JsonRecord): AuditLine | undefined {
  const { v, seq, at, prev, hash } = record;
  const event = parseEvent(record['event']);
  if (v === AUDIT_VERSION && isNonNegativeInteger(seq) && seq > 0 && isInstant(at) && isSha256(prev) && isSha256(hash) && event !== undefined) {
    return { v, seq, at, event, prev, hash };
  }
  return undefined;
}

/** The record after a review, or why the review cannot follow what the log already holds. */
function reviewed(record: RequestRecord, review: Review, at: string): RequestRecord | string {
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
function started(record: RequestRecord, nonce: string, at: string): RequestRecord | string {
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
function nextRecord(record: RequestRecord, event: RecordEvent, at: string): RequestRecord | string {
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
  private readonly records: Map<string, RequestRecord>;
  private seq: number;
  private lastHash: string;

  constructor(from: AuditState) {
    this.records = new Map(from.records);
    this.seq = from.seq;
    this.lastHash = from.lastHash;
  }

  /** Takes one raw line: the line read, or why it breaks the log (nothing is taken then). */
  take(raw: string): AuditLine | string {
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

  state(): AuditState {
    return { records: new Map(this.records), seq: this.seq, lastHash: this.lastHash };
  }

  /** Applies an event, or gives why it cannot follow what the log holds. */
  private apply(event: AuditEvent, at: string): string | undefined {
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
export function readAudit(text: string): AuditRead {
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
  private readonly path: string;
  private readonly files: Files;
  private readonly lock: Mutex;
  private readonly clock: Clock;

  constructor(path: string, files: Files, lock: Mutex, clock: Clock) {
    this.path = path;
    this.files = files;
    this.lock = lock;
    this.clock = clock;
  }

  async read(): Promise<AuditRead> {
    return readAudit((await this.files.read(this.path)) ?? '');
  }

  /**
   * Appends the event `decide` picks from the current state, under the lock. `decide` is synchronous so the lock is
   * held for milliseconds: checks that take longer (git, the dry run) happen before the call. The line is read back
   * and checked like any other before it is written, so this never writes a line the log would refuse. Throws
   * AuditChainError when the log is broken, and writes nothing more to it.
   */
  async append(decide: (state: AuditState) => AuditDecision): Promise<AuditAppend> {
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
