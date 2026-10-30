import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { TimeZone } from '../core/zone.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { appendRecord, parseLedger, type LoadRecord } from './ledger.ts';
import { endLoad, startLoad, type LoadPorts, type LoadRules, type LoadStart } from './jobs.ts';

const LEDGER = '/team/data/deploys/ledger.jsonl';
const NOW = Date.parse('2030-01-08T12:00:00Z');
const RULES: LoadRules = { knownTargets: ['api', 'workers'], scanner: new SecretScanner(), nowMs: NOW, zone: TimeZone.UTC };
const START: LoadStart = { session: 'ops', what: 'db trim', targets: 'host', startedAt: NOW - 3_600_000 };

function ports(files: MemoryFiles, ids: readonly string[]): LoadPorts {
  let next = 0;
  return {
    files,
    newId: () => {
      const id = ids[next] ?? `fresh-${next}`;
      next += 1;
      return id;
    },
  };
}

async function ledgerOf(files: MemoryFiles): Promise<ReturnType<typeof parseLedger>> {
  return parseLedger((await files.read(LEDGER)) ?? '');
}

describe('startLoad', () => {
  it('writes an open job under the first 8 characters of a new id no other job has', async () => {
    const files = new MemoryFiles();
    const taken: LoadRecord = { type: 'load', id: 'aaaaaaaa', session: 'dev', what: 'reindex', targets: ['api'], startedAt: '2030-01-07T09:00:00.000Z', endedAt: '2030-01-07T10:00:00.000Z' };
    await appendRecord(files, LEDGER, taken);
    const outcome = await startLoad(ports(files, ['aaaaaaaa-1111', 'bbbbbbbb-2222']), LEDGER, RULES, { ...START, targets: ['api', 'workers'] });
    const record: LoadRecord = { type: 'load', id: 'bbbbbbbb', session: 'ops', what: 'db trim', targets: ['api', 'workers'], startedAt: '2030-01-08T11:00:00.000Z', endedAt: null };
    assert.deepEqual(outcome, { kind: 'done', record });
    assert.deepEqual(await ledgerOf(files), [taken, record]);
  });

  it('refuses a start in the future, a target no repository deploys and a secret in what it is, writing nothing', async () => {
    const files = new MemoryFiles();
    const refusals = await Promise.all(
      [
        { ...START, startedAt: NOW + 60_000 },
        { ...START, targets: ['api', 'db', 'cache'] },
        { ...START, what: 'trim with password=hunter22' },
      ].map(async (start) => startLoad(ports(files, []), LEDGER, RULES, start)),
    );
    const [future, unknown, secret] = refusals.map((outcome) => (outcome.kind === 'refused' ? outcome.reason : outcome.kind));
    assert.equal(future, 'a job cannot start in the future (2030-01-08 12:01 UTC)');
    assert.equal(unknown, 'db, cache are not a deploy target of this team (known: api, workers, host)');
    assert.match(secret ?? '', /^what the job is looks like it holds a secret \(/);
    assert.equal(files.get(LEDGER), undefined);
  });
});

describe('endLoad', () => {
  async function started(): Promise<{ files: MemoryFiles; record: LoadRecord }> {
    const files = new MemoryFiles();
    const outcome = await startLoad(ports(files, ['cafe0001-x']), LEDGER, RULES, START);
    assert.equal(outcome.kind, 'done');
    return { files, record: outcome.kind === 'done' ? outcome.record : assert.fail('not started') };
  }

  it('writes the end record of the session’s open job', async () => {
    const { files, record } = await started();
    const outcome = await endLoad(ports(files, []), LEDGER, { session: 'ops', id: 'cafe0001', endedAt: NOW - 600_000, nowMs: NOW, zone: TimeZone.UTC });
    const ended: LoadRecord = { ...record, endedAt: '2030-01-08T11:50:00.000Z' };
    assert.deepEqual(outcome, { kind: 'done', record: ended });
    assert.deepEqual(await ledgerOf(files), [record, ended]);
  });

  it('refuses an unknown or ended job, another session’s, and an end in the future or before its start', async () => {
    const { files } = await started();
    const end = { session: 'ops', id: 'cafe0001', endedAt: NOW, nowMs: NOW, zone: TimeZone.UTC };
    const reasons = [];
    for (const attempt of [{ ...end, id: 'beef0002' }, { ...end, session: 'dev' }, { ...end, endedAt: NOW + 60_000 }, { ...end, endedAt: NOW - 7_200_000 }]) {
      const outcome = await endLoad(ports(files, []), LEDGER, attempt);
      reasons.push(outcome.kind === 'refused' ? outcome.reason : outcome.kind);
    }
    assert.deepEqual(reasons, [
      'no open job "beef0002"',
      'job "cafe0001" belongs to ops',
      'a job cannot end in the future (2030-01-08 12:01 UTC)',
      'job "cafe0001" started at 2030-01-08 11:00 UTC, after 2030-01-08 10:00 UTC',
    ]);
    assert.equal((await endLoad(ports(files, []), LEDGER, end)).kind, 'done');
    assert.deepEqual(await endLoad(ports(files, []), LEDGER, end), { kind: 'refused', reason: 'no open job "cafe0001"' });
  });
});

describe("the job refusals in the team's zone", () => {
  it('print their times there, zone-marked', async () => {
    const files = new MemoryFiles();
    const rules = { ...RULES, zone: JERUSALEM };
    assert.deepEqual(await startLoad(ports(files, ['cafe0001-x']), LEDGER, rules, { ...START, startedAt: NOW + 60_000 }), {
      kind: 'refused',
      reason: 'a job cannot start in the future (2030-01-08 14:01 IST)',
    });
    assert.equal((await startLoad(ports(files, ['cafe0001-x']), LEDGER, rules, START)).kind, 'done');
    const end = { session: 'ops', id: 'cafe0001', nowMs: NOW, zone: JERUSALEM };
    assert.deepEqual(await endLoad(ports(files, []), LEDGER, { ...end, endedAt: NOW - 7_200_000 }), {
      kind: 'refused',
      reason: 'job "cafe0001" started at 2030-01-08 13:00 IST, after 2030-01-08 12:00 IST',
    });
  });
});
