import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ShellEnd } from '../core/shell-end.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { commandHeader, endLine, HELD_OPEN_LINE, KEPT_LOGS, LiveLog, pruneLogs, reserveLog } from './logs.ts';

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

describe('LiveLog', () => {
  const LOG = `${DIR}/test-1.log`;
  /** The log after `chunks` and the run's end, as `LiveLog` writes it. */
  async function logged(chunks: readonly string[], end: ShellEnd, heldOpen = false): Promise<string | undefined> {
    const files = new MemoryFiles({ [LOG]: '$ npm test\n' });
    const live = new LiveLog(files, LOG);
    for (const chunk of chunks) {
      live.write(chunk);
    }
    await live.end(end, heldOpen);
    return files.get(LOG);
  }

  it('holds what the command printed and how it ended, for the line after the command', async () => {
    assert.equal(await logged(['ok 1\nnot ok 2'], { kind: 'exited', code: 1 }), '$ npm test\nok 1\nnot ok 2\nexit 1\n');
    assert.equal(await logged(['done\n'], { kind: 'exited', code: 0 }), '$ npm test\ndone\nexit 0\n');
    assert.equal(await logged([], { kind: 'signal', signal: 'SIGTERM' }), '$ npm test\nended by SIGTERM\n');
  });

  it('writes each whole line as it arrives, before the run ends (#719)', async () => {
    const files = new MemoryFiles({ [LOG]: '$ npm test\n' });
    const live = new LiveLog(files, LOG);
    live.write('ok 1\nok ');
    live.write('2\nok 3');
    await new Promise((done) => setImmediate(done));
    assert.equal(files.get(LOG), '$ npm test\nok 1\nok 2\n', 'the part line waits for its end');
  });

  it('cleans the lines as the whole output is cleaned, across pieces that split a line end or a colour code', async () => {
    const chunks = ['\u001b[31mnot ok 1\u001b[39m\r', '\nprogress 10%\rprogress 100%\n\u001b[3', '2mok 2\u001b[39m\n'];
    assert.equal(await logged(chunks, { kind: 'exited', code: 1 }), '$ npm test\nnot ok 1\nprogress 100%\nok 2\nexit 1\n');
  });

  it('says when a process the command started still held its output open (#719)', async () => {
    assert.equal(await logged(['ok 1\n'], { kind: 'exited', code: 0 }, true), `$ npm test\nok 1\n${HELD_OPEN_LINE}\nexit 0\n`);
  });

  it('throws the first write that failed at its end, and writes nothing after it', async () => {
    const files = new FaultyFiles(new MemoryFiles({ [LOG]: '$ npm test\n' })).fail('append', LOG, systemError('ENOSPC'));
    const live = new LiveLog(files, LOG);
    live.write('ok 1\n');
    await assert.rejects(live.end({ kind: 'exited', code: 0 }, false), /ENOSPC/);
  });

  it('says how a command ended in one line', () => {
    assert.equal(endLine({ kind: 'exited', code: 3 }), 'exit 3');
    assert.equal(endLine({ kind: 'signal', signal: 'SIGKILL' }), 'ended by SIGKILL');
  });
});
