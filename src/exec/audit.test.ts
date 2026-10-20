import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execRequest } from '../testing/exec-request.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { parseObject } from '../core/jsonl.ts';
import { MS_PER_MINUTE } from '../core/time.ts';
import {
  AuditChainError,
  AuditLog,
  EMPTY_AUDIT,
  GENESIS_HASH,
  nextRequestId,
  readAudit,
  type AuditAppend,
  type AuditEvent,
  type AuditState,
  type Review,
  type RunOutcome,
} from './audit.ts';
import { canonicalJson, sha256Hex } from './digest.ts';
import { requestSha256, type ExecRequest } from './request.ts';

const PATH = 'C:/team/exec/audit.jsonl';
const START = '2030-01-07T10:00:00.000Z';
const REFUSED: Partial<Review> = { decision: 'refused', note: 'use the refill route', expiresAt: null, nonce: null };
const ESCALATED: Partial<Review> = { decision: 'escalated', ownerGated: true, note: 'deletes history', expiresAt: null, nonce: null };

function outcome(text: string, exitCode: number | null = 0): RunOutcome {
  return { exitCode, timedOut: false, outputSha256: sha256Hex(text), outputFile: `C:/team/exec/out/${text}.log`, tail: text };
}

function setup(): { clock: FakeClock; files: MemoryFiles; lock: InlineMutex; log: AuditLog } {
  const clock = new FakeClock(START);
  const files = new MemoryFiles({}, clock);
  const lock = new InlineMutex();
  return { clock, files, lock, log: new AuditLog(PATH, files, lock, clock) };
}

/** An approval of `request` as reviewed with `dryRun`, valid for 30 minutes from START. */
function review(request: ExecRequest, dryRun: RunOutcome | null, overrides: Partial<Review> = {}): Review {
  return {
    id: request.id,
    decision: 'approved',
    reviewer: 'security',
    ownerGated: false,
    note: 'script read at the bound commit',
    requestSha256: requestSha256(request),
    dryRunSha256: dryRun?.outputSha256 ?? null,
    expiresAt: '2030-01-07T10:30:00.000Z',
    nonce: 'nonce-1',
    scheme: 'unsigned',
    signature: '',
    ...overrides,
  };
}

async function appended(log: AuditLog, event: AuditEvent): Promise<AuditState> {
  const result = await log.append(() => event);
  assert.ok(result.ok, result.ok ? '' : result.refusal);
  return result.state;
}

function refusalOf(result: AuditAppend): string {
  assert.equal(result.ok, false, 'expected a refusal');
  return result.ok ? '' : result.refusal;
}

/** Appends a request, its dry run and an approval, so the request is ready to run. */
async function approved(log: AuditLog, request: ExecRequest = execRequest()): Promise<void> {
  const dryRun = outcome('dry');
  await appended(log, { type: 'request', request });
  await appended(log, { type: 'dry-run', id: request.id, outcome: dryRun });
  await appended(log, { type: 'review', review: review(request, dryRun) });
}

function linesOf(files: MemoryFiles): string[] {
  return (files.get(PATH) ?? '').split('\n').filter((line) => line !== '');
}

function stateOf(text: string): AuditState {
  const read = readAudit(text);
  assert.ok(read.ok, read.ok ? '' : `line ${read.line}: ${read.reason}`);
  return read.state;
}

describe('AuditLog (T755)', () => {
  it('chains each line to the one before, from the genesis hash, under the lock', async () => {
    const { clock, files, lock, log } = setup();
    await appended(log, { type: 'request', request: execRequest() });
    clock.advance(1000);
    await appended(log, { type: 'dry-run', id: 'R1', outcome: outcome('dry') });
    const [first, second] = linesOf(files).map(parseObject);
    assert.ok(first !== undefined && second !== undefined);
    const { hash, ...body } = first;
    assert.equal(hash, sha256Hex(canonicalJson(body)));
    assert.deepEqual([body['v'], body['seq'], body['at'], body['prev']], [1, 1, START, GENESIS_HASH]);
    assert.deepEqual([second['seq'], second['at'], second['prev']], [2, '2030-01-07T10:00:01.000Z', hash]);
    assert.equal(lock.runs, 2);
  });

  it("derives each request's life from its lines alone", async () => {
    const { clock, files, log } = setup();
    await approved(log);
    clock.advance(MS_PER_MINUTE);
    await appended(log, { type: 'run-start', id: 'R1', nonce: 'nonce-1' });
    await appended(log, { type: 'run-end', id: 'R1', outcome: outcome('run', 0) });
    const state = stateOf(files.get(PATH) ?? '');
    const record = state.records.get('R1');
    assert.equal(record?.dryRun?.tail, 'dry');
    assert.equal(record?.review?.decision, 'approved');
    assert.deepEqual(record?.runStart, { nonce: 'nonce-1', at: '2030-01-07T10:01:00.000Z' });
    assert.equal(record?.runEnd?.exitCode, 0);
    assert.deepEqual([state.seq, nextRequestId(state)], [5, 'R2']);
  });

  it('burns the nonce once: a second run of one approval is refused and nothing is written', async () => {
    const { files, log } = setup();
    await approved(log);
    await appended(log, { type: 'run-start', id: 'R1', nonce: 'nonce-1' });
    assert.match(refusalOf(await log.append(() => ({ type: 'run-start', id: 'R1', nonce: 'nonce-1' }))), /already ran at .*single use/u);
    assert.equal(linesOf(files).length, 4);
  });

  it('refuses a run with a foreign nonce, after its approval expires, or before its window opens', async () => {
    const foreign = setup();
    await approved(foreign.log);
    assert.match(refusalOf(await foreign.log.append(() => ({ type: 'run-start', id: 'R1', nonce: 'guess' }))), /did not issue/u);
    const late = setup();
    await approved(late.log);
    late.clock.advance(31 * MS_PER_MINUTE);
    assert.match(refusalOf(await late.log.append(() => ({ type: 'run-start', id: 'R1', nonce: 'nonce-1' }))), /expired at 2030-01-07T10:30:00.000Z/u);
    const early = setup();
    await approved(early.log, execRequest({ window: { runAfter: '2030-01-07T11:00:00.000Z', expiresBy: '2030-01-07T13:00:00.000Z' } }));
    assert.match(refusalOf(await early.log.append(() => ({ type: 'run-start', id: 'R1', nonce: 'nonce-1' }))), /may not run before 2030-01-07T11:00:00.000Z/u);
  });

  it('refuses a review that does not match the request or dry run the log holds', async () => {
    const { log } = setup();
    const request = execRequest();
    await appended(log, { type: 'request', request });
    const early = await log.append(() => ({ type: 'review', review: review(request, null) }));
    assert.match(refusalOf(early), /dry run has not run yet/u);
    await appended(log, { type: 'dry-run', id: 'R1', outcome: outcome('dry') });
    const other = review(execRequest({ envNames: ['CLOUD_DB_URI'] }), outcome('dry'));
    assert.match(refusalOf(await log.append(() => ({ type: 'review', review: other }))), /different request/u);
    assert.match(refusalOf(await log.append(() => ({ type: 'review', review: review(request, outcome('forged')) }))), /different dry run/u);
    await appended(log, { type: 'review', review: review(request, outcome('dry'), REFUSED) });
    assert.match(refusalOf(await log.append(() => ({ type: 'review', review: review(request, outcome('dry')) }))), /already refused/u);
    assert.match(refusalOf(await log.append(() => ({ type: 'run-start', id: 'R1', nonce: 'nonce-1' }))), /has no approval/u);
  });

  it('takes one dry run, before any review, and only for a request with a dry-run form', async () => {
    const { log } = setup();
    await appended(log, { type: 'request', request: execRequest() });
    await appended(log, { type: 'dry-run', id: 'R1', outcome: outcome('dry') });
    assert.match(refusalOf(await log.append(() => ({ type: 'dry-run', id: 'R1', outcome: outcome('again') }))), /already has a dry run/u);
    const route = execRequest({ id: 'R2', kind: 'route', dryRunArgv: null, dryRunProgram: null, preview: 'GET /x' });
    await appended(log, { type: 'request', request: route });
    assert.match(refusalOf(await log.append(() => ({ type: 'dry-run', id: 'R2', outcome: outcome('dry') }))), /has no dry-run form/u);
    await appended(log, { type: 'review', review: review(route, null, REFUSED) });
    await appended(log, { type: 'request', request: execRequest({ id: 'R3' }) });
    await appended(log, { type: 'review', review: review(execRequest({ id: 'R3' }), null, REFUSED) });
    assert.match(refusalOf(await log.append(() => ({ type: 'dry-run', id: 'R3', outcome: outcome('dry') }))), /dry run comes before the review/u);
  });

  it('hands an escalated request on: one escalation, then one settling review', async () => {
    const { files, log } = setup();
    const request = execRequest();
    const dryRun = outcome('dry');
    await appended(log, { type: 'request', request });
    await appended(log, { type: 'dry-run', id: 'R1', outcome: dryRun });
    await appended(log, { type: 'review', review: review(request, dryRun, ESCALATED) });
    assert.match(refusalOf(await log.append(() => ({ type: 'review', review: review(request, dryRun, ESCALATED) }))), /already escalated/u);
    await appended(log, { type: 'review', review: review(request, dryRun, { reviewer: 'owner', ownerGated: true }) });
    const record = stateOf(files.get(PATH) ?? '').records.get('R1');
    assert.deepEqual([record?.escalation?.reviewer, record?.review?.reviewer], ['security', 'owner']);
  });

  it('numbers requests in order and refuses events for requests it never saw', async () => {
    const { log } = setup();
    assert.match(refusalOf(await log.append(() => ({ type: 'request', request: execRequest({ id: 'R2' }) }))), /next request is R1, not R2/u);
    assert.match(refusalOf(await log.append(() => ({ type: 'dry-run', id: 'R1', outcome: outcome('dry') }))), /a dry-run for R1, which no request created/u);
    const first = await log.append((state) => ({ type: 'request', request: execRequest({ id: nextRequestId(state) }) }));
    const second = await log.append((state) => ({ type: 'request', request: execRequest({ id: nextRequestId(state) }) }));
    assert.deepEqual([first.ok && first.state.records.size, second.ok && nextRequestId(second.state)], [1, 'R3']);
    assert.match(refusalOf(await log.append(() => ({ type: 'run-end', id: 'R2', outcome: outcome('run') }))), /R2 has not started/u);
  });

  it("passes the caller's refusal through and writes nothing", async () => {
    const { files, log } = setup();
    assert.equal(refusalOf(await log.append(() => ({ refusal: 'R9 is not yours to review' }))), 'R9 is not yours to review');
    assert.equal(files.get(PATH), undefined);
  });
});

describe('readAudit chain checks (T755)', () => {
  /** A three-line log: a request, its dry run and its approval. */
  async function threeLines(): Promise<string[]> {
    const { files, log } = setup();
    await approved(log);
    return linesOf(files);
  }

  it('reads a missing or empty log as empty, and Windows line ends as well as Unix ones', async () => {
    assert.deepEqual(readAudit(''), { ok: true, state: EMPTY_AUDIT });
    const lines = await threeLines();
    assert.equal(stateOf(`${lines.join('\r\n')}\r\n`).seq, 3);
  });

  it('names the first line that breaks the chain, and why', async () => {
    const [one = '', two = '', three = ''] = await threeLines();
    const cases: readonly (readonly [string, number, RegExp])[] = [
      [[one, two.replace('"tail":"dry"', '"tail":"dry!"'), three].join('\n'), 2, /edited after it was written/u],
      [[one, three].join('\n'), 2, /seq 3 follows seq 1: a line is missing or repeated/u],
      [[one, two, three, '{"v":1,"seq":4'].join('\n'), 4, /torn or edited line/u],
      [[one, two, three, '{"v":2,"seq":4}'].join('\n'), 4, /format v2; this teamrig reads v1: update teamrig/u],
      [[one, '{"v":1,"seq":2,"event":{"type":"dry-run"}}'].join('\n'), 2, /not an audit line/u],
    ];
    for (const [text, line, reason] of cases) {
      const read = readAudit(text);
      assert.equal(read.ok, false);
      assert.deepEqual(read.ok ? [] : [read.line], [line]);
      assert.match(read.ok ? '' : read.reason, reason);
    }
  });

  it('catches a line swapped for a rehashed one: the next line no longer chains to it', async () => {
    const [, two = '', three = ''] = await threeLines();
    const { files, log } = setup();
    await appended(log, { type: 'request', request: execRequest({ purpose: 'something else' }) });
    const read = readAudit([linesOf(files)[0], two, three].join('\n'));
    assert.deepEqual(read.ok ? [] : [read.line, read.reason], [2, 'prev is not the hash of the line before: the log was cut or reordered']);
  });

  it('refuses to append to a broken log, and leaves it as it is', async () => {
    const [one = '', two = '', three = ''] = await threeLines();
    const broken = `${[one, two.replace('"tail":"dry"', '"tail":"dry!"'), three].join('\n')}\n`;
    const clock = new FakeClock(START);
    const files = new MemoryFiles({ [PATH]: broken }, clock);
    const log = new AuditLog(PATH, files, new InlineMutex(), clock);
    await assert.rejects(
      log.append(() => ({ type: 'run-start', id: 'R1', nonce: 'nonce-1' })),
      (error: unknown) => error instanceof AuditChainError && error.line === 2 && /edited after it was written/u.test(error.message),
    );
    assert.equal(files.get(PATH), broken);
  });
});
