import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fieldPaths } from '../testing/field-paths.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { deadRunsOf, diedText, formatRunRecord, parseRunRecord, runRecordPathOf, type DetachedRunRecord } from './detached-runs.ts';

const DIR = resolve('/', 'deploys', 'detached');
const WAITING: DetachedRunRecord = {
  v: 1,
  id: '20300108-100000-4242',
  team: 'app',
  session: 'alpha',
  what: 'build api',
  log: join(DIR, '20300108-100000-4242.log'),
  pid: 4242,
  startedAt: '2030-01-08T10:00:00.000Z',
};
const RUNNING: DetachedRunRecord = { ...WAITING, runningAt: '2030-01-08T10:05:00.000Z' };

describe('the detached run record', () => {
  it('reads back what it wrote, waiting and running, beside its log', () => {
    assert.deepEqual(parseRunRecord(formatRunRecord(WAITING)), WAITING);
    assert.deepEqual(parseRunRecord(formatRunRecord(RUNNING)), RUNNING);
    assert.equal(runRecordPathOf(DIR, WAITING.id), join(DIR, '20300108-100000-4242.run.json'));
  });

  it('writes the fields of format 1: a field added is a new format (CONTRIBUTING, Stored files)', () => {
    const written: unknown = JSON.parse(formatRunRecord(RUNNING));
    assert.deepEqual(fieldPaths(written), ['id', 'log', 'pid', 'runningAt', 'session', 'startedAt', 'team', 'v', 'what']);
  });

  it('reads a torn file, another format or a damaged field as no record', () => {
    const damaged = ['', '{', '[]', '{"v":2}', JSON.stringify({ ...WAITING, v: 2 }), JSON.stringify({ ...WAITING, pid: '4242' }), JSON.stringify({ ...WAITING, pid: 4242.5 }), JSON.stringify({ ...WAITING, session: 7 })];
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

describe('diedText', () => {
  it('says the stage the run died at, its pid and its log', () => {
    assert.equal(
      diedText(WAITING),
      `queue ${WAITING.id} died while it waited for its turn: build api: its process (pid 4242) ended with no end of its own, so nothing else reports it; re-run it; log ${WAITING.log}`,
    );
    assert.match(diedText(RUNNING), /^queue 20300108-100000-4242 died while its step ran: build api: /);
  });
});
