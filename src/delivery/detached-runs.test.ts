import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fieldPaths } from '../testing/field-paths.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { deadRunsOf, DIED_EXIT, diedEndOf, diedText, formatRunRecord, parseRunRecord, RUN_RECORD_FORMAT, runRecordPathOf, type DetachedRunRecord } from './detached-runs.ts';
import type { QueuedStepRecord } from './ledger.ts';

const DIR = resolve('/', 'deploys', 'detached');
const WAITING: DetachedRunRecord = {
  v: RUN_RECORD_FORMAT,
  id: '20300108-100000-4242',
  team: 'app',
  session: 'alpha',
  what: 'build api',
  log: join(DIR, '20300108-100000-4242.log'),
  pid: 4242,
  startedAt: '2030-01-08T10:00:00.000Z',
};
const RUNNING: DetachedRunRecord = { ...WAITING, runningAt: '2030-01-08T10:05:00.000Z' };
const LEDGER = resolve('/', 'deploys', 'ledger.jsonl');
const START: QueuedStepRecord = { type: 'heavy', id: 'step-7', session: 'alpha', what: 'build api', kind: 'build', kit: '0.1.0', startedAt: '2030-01-08T10:05:00.000Z', endedAt: null, exitCode: null };
const OPENED: DetachedRunRecord = { ...RUNNING, step: { ledger: LEDGER, start: START } };

describe('the detached run record', () => {
  it('reads back what it wrote, waiting and running, beside its log', () => {
    assert.deepEqual(parseRunRecord(formatRunRecord(WAITING)), WAITING);
    assert.deepEqual(parseRunRecord(formatRunRecord(RUNNING)), RUNNING);
    assert.deepEqual(parseRunRecord(formatRunRecord(OPENED)), OPENED);
    assert.equal(runRecordPathOf(DIR, WAITING.id), join(DIR, '20300108-100000-4242.run.json'));
  });

  it('writes the fields of format 2: a field added is a new format (CONTRIBUTING, Stored files)', () => {
    const written: unknown = JSON.parse(formatRunRecord(OPENED));
    const start = ['endedAt', 'exitCode', 'id', 'kind', 'kit', 'session', 'startedAt', 'type', 'what'].map((field) => `step.start.${field}`);
    assert.deepEqual(fieldPaths(written), ['id', 'log', 'pid', 'runningAt', 'session', 'startedAt', 'step.ledger', ...start, 'team', 'v', 'what']);
  });

  it('reads a format 1 record, which has no step, as format 2 (T2942)', () => {
    assert.deepEqual(parseRunRecord(JSON.stringify({ ...RUNNING, v: 1 })), RUNNING);
    assert.deepEqual(parseRunRecord(JSON.stringify({ ...OPENED, v: 1 })), RUNNING, 'a step belongs to format 2 only');
  });

  it('reads a record whose step is damaged as one with no step, so its death is still told', () => {
    const damaged: readonly unknown[] = [null, 'step', { ledger: LEDGER }, { ledger: 7, start: START }, { ledger: LEDGER, start: { ...START, type: 'deploy' } }, { ledger: LEDGER, start: { ...START, endedAt: 7 } }];
    for (const step of damaged) {
      assert.deepEqual(parseRunRecord(JSON.stringify({ ...RUNNING, step })), RUNNING, JSON.stringify(step));
    }
  });

  it('reads a torn file, another format or a damaged field as no record', () => {
    const damaged = ['', '{', '[]', '{"v":2}', JSON.stringify({ ...WAITING, v: 3 }), JSON.stringify({ ...WAITING, pid: '4242' }), JSON.stringify({ ...WAITING, pid: 4242.5 }), JSON.stringify({ ...WAITING, session: 7 })];
    for (const text of damaged) {
      assert.equal(parseRunRecord(text), undefined, text);
    }
  });
});

describe('deadRunsOf', () => {
  it("finds only this team's runs whose process is gone, passing over logs, torn records and live runs", async () => {
    const path = (id: string): string => runRecordPathOf(DIR, id);
    const files = new MemoryFiles({
      [path('dead')]: formatRunRecord({ ...WAITING, id: 'dead', pid: 1 }),
      [path('live')]: formatRunRecord({ ...RUNNING, id: 'live', pid: 2 }),
      [path('other-team')]: formatRunRecord({ ...WAITING, id: 'other-team', team: 'web', pid: 3 }),
      [path('torn')]: '{"v":1,',
      [join(DIR, 'dead.log')]: 'waiting for the host lock\n',
    });
    const dead = await deadRunsOf({ files, alive: (pid) => pid === 2 }, DIR, 'app');
    assert.deepEqual(dead, [{ path: path('dead'), record: { ...WAITING, id: 'dead', pid: 1 } }]);
  });

  it('finds none in a folder no run has written to', async () => {
    assert.deepEqual(await deadRunsOf({ files: new MemoryFiles(), alive: () => false }, DIR, 'app'), []);
  });
});

describe('diedEndOf', () => {
  it("ends the step under its start's id at the sweep's time, exit 1, keeping the start's fields (T2942)", () => {
    assert.equal(DIED_EXIT, 1);
    assert.deepEqual(diedEndOf({ ...START, waits: { lock: 60_000 }, task: 'T7' }, '2030-01-08T11:00:00.000Z'), { ...START, waits: { lock: 60_000 }, task: 'T7', endedAt: '2030-01-08T11:00:00.000Z', exitCode: 1 });
  });
});

describe('diedText', () => {
  it('says the stage the run died at, its pid and its log', () => {
    assert.equal(
      diedText(WAITING),
      `queue ${WAITING.id} died while it waited for its turn: build api: its process (pid 4242) ended with no end of its own, so nothing else reports it; re-run it; log ${WAITING.log}`,
    );
    assert.match(diedText(RUNNING), /^queue 20300108-100000-4242 died while its step ran: build api: /);
  });
});
