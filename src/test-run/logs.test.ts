import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import { commandHeader, endLine, KEPT_LOGS, logBody, pruneLogs, reserveLog } from './logs.ts';

const DIR = '/kit/teams/app/state/logs';

/** Memory files that also refuse the first `taken` names asked for, as when another run created them first. */
class RacedFiles extends MemoryFiles {
  private taken: number;

  constructor(taken: number) {
    super();
    this.taken = taken;
  }

  override async createExclusive(path: string, text: string): Promise<boolean> {
    if (this.taken > 0) {
      this.taken -= 1;
      return false;
    }
    return super.createExclusive(path, text);
  }
}

describe('reserveLog', () => {
  it("numbers a session's first log 1 and holds the command line until the run ends", async () => {
    const files = new MemoryFiles();
    const path = await reserveLog(files, DIR, 'api', commandHeader('npm test'));
    assert.equal(path.replaceAll('\\', '/'), `${DIR}/test-api-1.log`);
    assert.equal(files.get(path), '$ npm test\n');
  });

  it("numbers a log one past the session's newest, whatever other sessions and files hold", async () => {
    const files = new MemoryFiles({
      [`${DIR}/test-api-2.log`]: '',
      [`${DIR}/test-api-10.log`]: '',
      [`${DIR}/test-api-x-40.log`]: '',
      [`${DIR}/test-web-50.log`]: '',
      [`${DIR}/test-api-notes.log`]: '',
      [`${DIR}/test-api-7.txt`]: '',
    });
    assert.ok((await reserveLog(files, DIR, 'api', '')).endsWith('test-api-11.log'));
    assert.ok((await reserveLog(files, DIR, 'api-x', '')).endsWith('test-api-x-41.log'));
  });

  it('names the logs of runs with no session test-<n>.log, apart from any session', async () => {
    const files = new MemoryFiles({ [`${DIR}/test-api-9.log`]: '', [`${DIR}/test-3.log`]: '' });
    assert.ok((await reserveLog(files, DIR, null, '')).endsWith('test-4.log'));
  });

  it('moves on to the next number when another run took the name first', async () => {
    const files = new RacedFiles(2);
    assert.ok((await reserveLog(files, DIR, 'api', '')).endsWith('test-api-3.log'));
  });
});

describe('pruneLogs', () => {
  it("keeps a session's newest logs and removes older ones, leaving other sessions' alone", async () => {
    const initial: Record<string, string> = { [`${DIR}/test-web-1.log`]: '', [`${DIR}/test-1.log`]: '' };
    for (let n = 1; n <= KEPT_LOGS + 2; n += 1) {
      initial[`${DIR}/test-api-${n}.log`] = '';
    }
    const files = new MemoryFiles(initial);
    await pruneLogs(files, DIR, 'api');
    const left = files.paths().map((path) => path.slice(DIR.length + 1));
    assert.equal(left.filter((name) => name.startsWith('test-api-')).length, KEPT_LOGS);
    assert.ok(!left.includes('test-api-1.log') && !left.includes('test-api-2.log') && left.includes('test-api-3.log'));
    assert.ok(left.includes('test-web-1.log') && left.includes('test-1.log'));
  });

  it('keeps as many as asked, and does nothing in a folder not made yet', async () => {
    const files = new MemoryFiles({ [`${DIR}/test-1.log`]: '', [`${DIR}/test-2.log`]: '' });
    await pruneLogs(files, DIR, null, 1);
    assert.deepEqual(files.paths(), [`${DIR}/test-2.log`]);
    await pruneLogs(files, '/kit/logs', null);
    assert.deepEqual(files.paths(), [`${DIR}/test-2.log`]);
  });
});

describe('logBody', () => {
  it('holds what the command printed and how it ended, for the line after the command', () => {
    assert.equal(logBody('ok 1\nnot ok 2', { kind: 'exited', code: 1 }), 'ok 1\nnot ok 2\nexit 1\n');
    assert.equal(logBody('done\n', { kind: 'exited', code: 0 }), 'done\nexit 0\n');
    assert.equal(logBody('', { kind: 'signal', signal: 'SIGTERM' }), 'ended by SIGTERM\n');
  });

  it('says how a command ended in one line', () => {
    assert.equal(endLine({ kind: 'exited', code: 3 }), 'exit 3');
    assert.equal(endLine({ kind: 'signal', signal: 'SIGKILL' }), 'ended by SIGKILL');
  });
});
