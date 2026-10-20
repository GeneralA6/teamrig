import { randomBytes } from 'node:crypto';
import { MS_PER_HOUR, MS_PER_MINUTE } from '../core/time.ts';
import type { AuditDecision, AuditState, RequestRecord, Review, ReviewDecision } from './audit.ts';
import { canonicalJson } from './digest.ts';
import { requestSha256, type RunWindow } from './request.ts';

/** How long an approval lasts when the request names no window (spec §8). */
export const DEFAULT_APPROVAL_MS = 30 * MS_PER_MINUTE;

/** The longest an approval lasts, even inside a longer window (spec §8). */
export const MAX_APPROVAL_MS = 4 * MS_PER_HOUR;

/** Phase 1's scheme (spec §12a): approvals carry no key yet; the reviewer account signs from increment (c). */
export const UNSIGNED_SCHEME = 'unsigned';

/** A review as signed: every field but the signature. */
export type UnsignedReview = Omit<Review, 'signature'>;

/** A signature with the scheme that made it and the text it covers. */
export interface Signed {
  readonly scheme: string;
  readonly payload: string;
  readonly signature: string;
}

/** Signs what a review binds, with the reviewer's key. */
export interface ReviewSigner {
  readonly scheme: string;
  sign(payload: string): string;
}

/** Checks a review's signature before the executor acts on it. */
export interface ReviewVerifier {
  verify(signed: Signed): boolean;
}

/**
 * Phase 1: no keys exist, so a review's signature is empty and only its scheme is checked. What protects an approval
 * until then is the hash-chained log and its lock (spec §4), not the signature.
 */
export class UnsignedReviews implements ReviewSigner, ReviewVerifier {
  readonly scheme = UNSIGNED_SCHEME;

  sign(): string {
    return '';
  }

  verify({ scheme, signature }: Signed): boolean {
    return scheme === UNSIGNED_SCHEME && signature === '';
  }
}

/** Gives each approval its own single-use nonce. */
export interface NonceSource {
  next(): string;
}

/** 128 random bits as hex, so no two approvals share a nonce and a signed approval names exactly one run. */
export const RANDOM_NONCES: NonceSource = { next: () => randomBytes(16).toString('hex') };

/** Who may review: the owner by name (`register.ownerSource`) and the security reviewer's session, when the team has one. */
export interface Reviewers {
  readonly owner: string;
  readonly security: string | undefined;
}

/** What a review needs besides the log: who may review, the signer and the nonces. */
export interface ReviewKit {
  readonly reviewers: Reviewers;
  readonly signer: ReviewSigner;
  readonly nonces: NonceSource;
}

/** A reviewer's decision on one request, as asked on the command line. */
export interface ReviewAsk {
  readonly id: string;
  readonly decision: ReviewDecision;
  /** A session, or the owner. */
  readonly reviewer: string;
  readonly note: string;
}

/** What a review's signature covers: every field but the signature, as canonical JSON, named one by one. */
export function reviewPayload(review: UnsignedReview): string {
  return canonicalJson({
    id: review.id,
    decision: review.decision,
    reviewer: review.reviewer,
    ownerGated: review.ownerGated,
    note: review.note,
    requestSha256: review.requestSha256,
    dryRunSha256: review.dryRunSha256,
    expiresAt: review.expiresAt,
    nonce: review.nonce,
    scheme: review.scheme,
  });
}

/** Whether a review's signature is valid for what it binds; any field changed after signing makes it invalid. */
export function signatureValid(review: Review, verifier: ReviewVerifier): boolean {
  return verifier.verify({ scheme: review.scheme, payload: reviewPayload(review), signature: review.signature });
}

/**
 * An approval's last instant, given at `now` (spec §8): 30 minutes, or with a window until it closes, at most 4 h;
 * or why no approval given now could be used.
 */
export function approvalExpiry(window: RunWindow | null, now: number): number | string {
  if (window === null) {
    return now + DEFAULT_APPROVAL_MS;
  }
  const closes = Date.parse(window.expiresBy);
  if (closes <= now) {
    return `its window closed at ${window.expiresBy}`;
  }
  const expiry = Math.min(closes, now + MAX_APPROVAL_MS);
  if (expiry <= Date.parse(window.runAfter)) {
    return `its window opens at ${window.runAfter}, after an approval given now would expire (${MAX_APPROVAL_MS / MS_PER_HOUR} h): approve it nearer the time`;
  }
  return expiry;
}

/**
 * Why `ask.reviewer` may not make this decision (spec §7, §9), or undefined when they may. The owner settles anything;
 * the security reviewer settles every other session's request that is not owner-gated, and hands an owner-gated one to
 * the owner by escalating it with their review note.
 */
function reviewerProblem(record: RequestRecord, ask: ReviewAsk, { owner, security }: Reviewers): string | undefined {
  const { id, requester, ownerGated } = record.request;
  if (ask.reviewer === owner) {
    return ask.decision === 'escalated' ? `the owner settles ${id}: approve or refuse it` : undefined;
  }
  if (security === undefined) {
    return `no security reviewer is set (roles.securityReviewer), so only the owner (${owner}) reviews ${id}`;
  }
  if (ask.reviewer !== security) {
    return `${ask.reviewer} reviews nothing: the security reviewer (${security}) or the owner (${owner}) reviews ${id}`;
  }
  if (requester === security) {
    return `${id} is ${security}'s own request: the owner (${owner}) reviews it`;
  }
  if (ask.decision !== 'escalated' && (ownerGated || record.escalation !== undefined)) {
    return `${id} is owner-gated: the owner (${owner}) approves or refuses it; escalate it with your review note`;
  }
  return undefined;
}

function noteProblem({ decision, note }: ReviewAsk): string | undefined {
  if (decision === 'approved' || note.trim() !== '') {
    return undefined;
  }
  return decision === 'refused' ? 'a refusal needs a note: the reason and the safe alternative' : 'an escalation needs a note: why the owner must decide';
}

/** An approval's expiry and fresh nonce, or both null for any other decision; a string when no approval can be given now. */
function grantFor(ask: ReviewAsk, window: RunWindow | null, now: number, nonces: NonceSource): Pick<Review, 'expiresAt' | 'nonce'> | string {
  if (ask.decision !== 'approved') {
    return { expiresAt: null, nonce: null };
  }
  const expiry = approvalExpiry(window, now);
  return typeof expiry === 'string' ? expiry : { expiresAt: new Date(expiry).toISOString(), nonce: nonces.next() };
}

/**
 * The review line to append for `ask` at `now`, or why none may be: called under the audit lock, so it binds the request
 * and dry run the log holds at that moment. The log's own fold then refuses what does not fit the request's life: a
 * second settling review, a second escalation, an approval before the dry run.
 */
export function decideReview(state: AuditState, ask: ReviewAsk, now: number, kit: ReviewKit): AuditDecision {
  const record = state.records.get(ask.id);
  if (record === undefined) {
    return { refusal: `no request ${ask.id} in the audit log` };
  }
  const problem = reviewerProblem(record, ask, kit.reviewers) ?? noteProblem(ask);
  if (problem !== undefined) {
    return { refusal: problem };
  }
  const grant = grantFor(ask, record.request.window, now, kit.nonces);
  if (typeof grant === 'string') {
    return { refusal: `${ask.id} cannot be approved now: ${grant}` };
  }
  const review: UnsignedReview = {
    id: ask.id,
    decision: ask.decision,
    reviewer: ask.reviewer,
    ownerGated: record.request.ownerGated || record.escalation !== undefined || ask.decision === 'escalated',
    note: ask.note,
    requestSha256: requestSha256(record.request),
    dryRunSha256: record.dryRun?.outputSha256 ?? null,
    ...grant,
    scheme: kit.signer.scheme,
  };
  return { type: 'review', review: { ...review, signature: kit.signer.sign(reviewPayload(review)) } };
}
