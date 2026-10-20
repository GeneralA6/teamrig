import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execRequest } from '../testing/exec-request.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { MS_PER_HOUR, MS_PER_MINUTE } from '../core/time.ts';
import { AuditLog, type AuditAppend, type AuditEvent, type Review, type RunOutcome } from './audit.ts';
import { sha256Hex } from './digest.ts';
import { requestSha256, type ExecRequest } from './request.ts';
import {
  approvalExpiry,
  decideReview,
  RANDOM_NONCES,
  signatureValid,
  UnsignedReviews,
  type NonceSource,
  type ReviewAsk,
  type ReviewKit,
  type ReviewSigner,
  type ReviewVerifier,
  type Signed,
} from './review.ts';

const PATH = 'C:/team/exec/audit.jsonl';
const START = '2030-01-07T10:00:00.000Z';
const NOW = Date.parse(START);
const KIT: Omit<ReviewKit, 'nonces'> = { reviewers: { owner: 'owner', security: 'security' }, signer: new UnsignedReviews() };
const DRY_RUN: RunOutcome = { exitCode: 0, timedOut: false, outputSha256: sha256Hex('dry'), outputFile: 'C:/team/exec/out/R1-dry.log', tail: 'inserted 12' };

/** Nonces numbered in the order they are given, so a test can name the one an approval got. */
class CountingNonces implements NonceSource {
  private count = 0;

  next(): string {
    this.count += 1;
    return `nonce-${this.count}`;
  }
}

/** Signs with a hash of a fixed key and the payload, so a test sees exactly what a signature covers. */
class KeyedSigner implements ReviewSigner, ReviewVerifier {
  readonly scheme = 'test-keyed';

  sign(payload: string): string {
    return sha256Hex(`key:${payload}`);
  }

  verify({ scheme, payload, signature }: Signed): boolean {
    return scheme === this.scheme && signature === this.sign(payload);
  }
}

interface World {
  readonly review: (ask: Partial<ReviewAsk>) => Promise<AuditAppend>;
}

async function mustAppend(log: AuditLog, event: AuditEvent): Promise<void> {
  const result = await log.append(() => event);
  assert.ok(result.ok, result.ok ? '' : result.refusal);
}

/** A log holding `request`, and its dry run unless `dryRun` is false; `review` decides on it as the security reviewer by default. */
async function world(request: ExecRequest = execRequest(), kit: Partial<ReviewKit> = {}, dryRun = true): Promise<World> {
  const clock = new FakeClock(START);
  const log = new AuditLog(PATH, new MemoryFiles({}, clock), new InlineMutex(), clock);
  await mustAppend(log, { type: 'request', request });
  if (dryRun) {
    await mustAppend(log, { type: 'dry-run', id: request.id, outcome: DRY_RUN });
  }
  const full: ReviewKit = { ...KIT, nonces: new CountingNonces(), ...kit };
  const base: ReviewAsk = { id: request.id, decision: 'approved', reviewer: 'security', note: 'script read at the bound commit' };
  return { review: (ask) => log.append((state) => decideReview(state, { ...base, ...ask }, clock.now(), full)) };
}

function reviewOf(result: AuditAppend): Review {
  assert.ok(result.ok, result.ok ? '' : result.refusal);
  const { event } = result.line;
  assert.ok(event.type === 'review', `expected a review, got a ${event.type}`);
  return event.review;
}

function refusalOf(result: AuditAppend): string {
  assert.equal(result.ok, false, 'expected a refusal');
  return result.ok ? '' : result.refusal;
}

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

describe('approvalExpiry (T755)', () => {
  it('gives 30 minutes when the request names no window', () => {
    assert.equal(approvalExpiry(null, NOW), NOW + 30 * MS_PER_MINUTE);
  });

  it("lasts until the window closes, and never more than 4 h", () => {
    assert.equal(approvalExpiry({ runAfter: START, expiresBy: at(10 * MS_PER_MINUTE) }, NOW), NOW + 10 * MS_PER_MINUTE);
    assert.equal(approvalExpiry({ runAfter: START, expiresBy: at(6 * MS_PER_HOUR) }, NOW), NOW + 4 * MS_PER_HOUR);
  });

  it('refuses a window that has closed, or one that opens after an approval given now would expire', () => {
    assert.match(String(approvalExpiry({ runAfter: at(-2 * MS_PER_HOUR), expiresBy: at(-MS_PER_HOUR) }, NOW)), /window closed at/u);
    assert.match(String(approvalExpiry({ runAfter: at(5 * MS_PER_HOUR), expiresBy: at(6 * MS_PER_HOUR) }, NOW)), /approve it nearer the time/u);
  });
});

describe('decideReview (T755)', () => {
  it('binds the request and dry run the log holds, with a 30-minute single-use grant', async () => {
    const request = execRequest();
    const review = reviewOf(await (await world(request)).review({}));
    assert.deepEqual(review, {
      id: 'R1',
      decision: 'approved',
      reviewer: 'security',
      ownerGated: false,
      note: 'script read at the bound commit',
      requestSha256: requestSha256(request),
      dryRunSha256: DRY_RUN.outputSha256,
      expiresAt: '2030-01-07T10:30:00.000Z',
      nonce: 'nonce-1',
      scheme: 'unsigned',
      signature: '',
    });
  });

  it('gives an approval inside a window until the window closes', async () => {
    const request = execRequest({ window: { runAfter: at(MS_PER_HOUR), expiresBy: at(2 * MS_PER_HOUR) } });
    assert.equal(reviewOf(await (await world(request)).review({})).expiresAt, at(2 * MS_PER_HOUR));
  });

  it('refuses a session that is neither the security reviewer nor the owner, the requester too', async () => {
    const { review } = await world();
    assert.match(refusalOf(await review({ reviewer: 'alpha' })), /alpha reviews nothing: the security reviewer \(security\) or the owner \(owner\)/u);
    assert.match(refusalOf(await review({ reviewer: 'beta', decision: 'refused', note: 'no' })), /beta reviews nothing/u);
  });

  it("sends the security reviewer's own request to the owner", async () => {
    const { review } = await world(execRequest({ requester: 'security' }));
    assert.match(refusalOf(await review({ decision: 'escalated', note: 'mine' })), /R1 is security's own request: the owner \(owner\) reviews it/u);
    assert.equal(reviewOf(await review({ reviewer: 'owner' })).reviewer, 'owner');
  });

  it('lets only the owner review when the team has no security reviewer', async () => {
    const { review } = await world(execRequest(), { reviewers: { owner: 'owner', security: undefined } });
    assert.match(refusalOf(await review({})), /no security reviewer is set \(roles\.securityReviewer\), so only the owner \(owner\) reviews R1/u);
    assert.equal(reviewOf(await review({ reviewer: 'owner' })).decision, 'approved');
  });

  it('lets the security reviewer only escalate an owner-gated request, and the owner settle it', async () => {
    const { review } = await world(execRequest({ ownerGated: true }));
    assert.match(refusalOf(await review({})), /R1 is owner-gated: the owner \(owner\) approves or refuses it/u);
    assert.match(refusalOf(await review({ decision: 'refused', note: 'use the route' })), /owner-gated/u);
    const escalation = reviewOf(await review({ decision: 'escalated', note: 'checklist passes; deletes history' }));
    assert.deepEqual([escalation.ownerGated, escalation.expiresAt, escalation.nonce], [true, null, null]);
    const approval = reviewOf(await review({ reviewer: 'owner', note: '' }));
    assert.deepEqual([approval.reviewer, approval.ownerGated, approval.nonce], ['owner', true, 'nonce-1']);
  });

  it('makes an escalated request owner-gated, so the security reviewer can no longer settle it', async () => {
    const { review } = await world();
    assert.equal(reviewOf(await review({ decision: 'escalated', note: 'touches user data' })).ownerGated, true);
    assert.match(refusalOf(await review({})), /R1 is owner-gated/u);
    assert.match(refusalOf(await review({ decision: 'escalated', note: 'again' })), /R1 is already escalated to the owner/u);
  });

  it('never lets the owner escalate: the owner is who an escalation goes to', async () => {
    const { review } = await world();
    assert.match(refusalOf(await review({ reviewer: 'owner', decision: 'escalated', note: 'x' })), /the owner settles R1: approve or refuse it/u);
  });

  it('needs a note on a refusal or an escalation, not on an approval', async () => {
    const { review } = await world();
    assert.match(refusalOf(await review({ decision: 'refused', note: '  ' })), /a refusal needs a note: the reason and the safe alternative/u);
    assert.match(refusalOf(await review({ decision: 'escalated', note: '' })), /an escalation needs a note/u);
    const refusal = reviewOf(await review({ decision: 'refused', note: 'run the refill route instead' }));
    assert.deepEqual([refusal.decision, refusal.expiresAt, refusal.nonce], ['refused', null, null]);
  });

  it("leaves the request's life to the log: no approval before the dry run, none after a refusal", async () => {
    const { review } = await world(execRequest(), {}, false);
    assert.match(refusalOf(await review({})), /R1's dry run has not run yet/u);
    reviewOf(await review({ decision: 'refused', note: 'no dry run in time' }));
    assert.match(refusalOf(await review({})), /R1 is already refused/u);
  });

  it('refuses an unknown request, and an approval whose window has closed', async () => {
    assert.match(refusalOf(await (await world()).review({ id: 'R9' })), /no request R9 in the audit log/u);
    const closed = execRequest({ window: { runAfter: at(-2 * MS_PER_HOUR), expiresBy: at(-MS_PER_HOUR) } });
    assert.match(refusalOf(await (await world(closed)).review({})), /R1 cannot be approved now: its window closed at 2030-01-07T09:00:00\.000Z/u);
  });
});

describe('review signatures (T755)', () => {
  it("a signer's signature covers every field of the review but itself", async () => {
    const signer = new KeyedSigner();
    const review = reviewOf(await (await world(execRequest(), { signer })).review({}));
    assert.equal(review.scheme, 'test-keyed');
    assert.ok(signatureValid(review, signer));
    const changes: Partial<Review>[] = [
      { id: 'R2' },
      { decision: 'refused' },
      { reviewer: 'owner' },
      { ownerGated: true },
      { note: 'other' },
      { requestSha256: 'c'.repeat(64) },
      { dryRunSha256: null },
      { expiresAt: '2030-01-07T14:00:00.000Z' },
      { nonce: 'nonce-2' },
      { scheme: 'unsigned' },
    ];
    assert.deepEqual(new Set(changes.flatMap(Object.keys)), new Set(Object.keys(review).filter((key) => key !== 'signature')));
    for (const change of changes) {
      assert.equal(signatureValid({ ...review, ...change }, signer), false, `a change of ${Object.keys(change).join()} kept the signature valid`);
    }
  });

  it('passes an unsigned review only with the unsigned scheme and an empty signature', () => {
    const unsigned = new UnsignedReviews();
    assert.equal(unsigned.sign(), '');
    assert.ok(unsigned.verify({ scheme: 'unsigned', payload: '{}', signature: '' }));
    assert.equal(unsigned.verify({ scheme: 'unsigned', payload: '{}', signature: 'forged' }), false);
    assert.equal(unsigned.verify({ scheme: 'test-keyed', payload: '{}', signature: '' }), false);
  });

  it('gives each approval 128 random bits of hex as its nonce', () => {
    const [first, second] = [RANDOM_NONCES.next(), RANDOM_NONCES.next()];
    assert.match(first, /^[0-9a-f]{32}$/u);
    assert.notEqual(first, second);
  });
});
