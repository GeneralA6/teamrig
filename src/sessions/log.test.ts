import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NewerDataError } from '../core/jsonl.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { closedOf, homeCloseOf, readSessionLog, SESSION_LOG_FORMAT, SessionLog, type CloseRecord, type ReopenRecord } from './log.ts';

const PATH = '/team/state/session-log.jsonl';
const CLOSE: CloseRecord = { kind: 'close', session: 'alpha', by: 'lead', at: '2030-01-08T10:00:00.000Z', claudeSession: 'claude-1', idleMinutes: 75, freedMb: 1300 };
const RESUMED: ReopenRecord = { kind: 'reopen', session: 'alpha', at: '2030-01-08T12:00:00.000Z', resumed: 'claude-1' };

describe('the session log', () => {
  it('keeps closes and reopens in order, and reads back what it wrote', async () => {
    const files = new MemoryFiles();
    const log = new SessionLog(files, PATH);
    const fresh: ReopenRecord = { kind: 'reopen', session: 'bravo', at: '2030-01-08T12:05:00.000Z' };
    for (const record of [CLOSE, RESUMED, fresh]) {
      await log.append(record);
    }
    assert.deepEqual(await log.read(), { records: [CLOSE, RESUMED, fresh], skipped: 0 });
    assert.equal(files.get(PATH)?.split('\n')[0], JSON.stringify({ v: SESSION_LOG_FORMAT, ...CLOSE }));
  });

  it('keeps the folder a close resumes its session in, and reads a close without one or with a damaged one as none (T1408)', async () => {
    const files = new MemoryFiles();
    const inWorktree: CloseRecord = { ...CLOSE, folder: '/work/app/.claude/worktrees/fix' };
    await new SessionLog(files, PATH).append(inWorktree);
    await files.append(PATH, `${JSON.stringify({ v: SESSION_LOG_FORMAT, ...CLOSE, folder: 7 })}\n`);
    assert.deepEqual(await new SessionLog(files, PATH).read(), { records: [inWorktree, CLOSE], skipped: 0 });
  });

  it('keeps a home close, which names no Claude Code session, and reads one with a damaged session as one (T1364)', async () => {
    const files = new MemoryFiles();
    const home = homeCloseOf('bravo', 'lead', '2030-01-08T11:00:00.000Z');
    assert.deepEqual(home, { kind: 'close', session: 'bravo', by: 'lead', at: '2030-01-08T11:00:00.000Z', idleMinutes: 0, freedMb: 0 });
    await new SessionLog(files, PATH).append(home);
    await files.append(PATH, `${JSON.stringify({ v: SESSION_LOG_FORMAT, ...home, claudeSession: 7 })}\n`);
    assert.deepEqual(await new SessionLog(files, PATH).read(), { records: [home, home], skipped: 0 });
    assert.equal(closedOf([home], 'bravo'), home);
  });

  it('tells a session teamrig closed until it is reopened', () => {
    assert.equal(closedOf([CLOSE], 'alpha'), CLOSE);
    assert.equal(closedOf([CLOSE, RESUMED], 'alpha'), undefined);
    assert.equal(closedOf([CLOSE, RESUMED, { ...CLOSE, at: '2030-01-09T10:00:00.000Z' }], 'alpha')?.at, '2030-01-09T10:00:00.000Z');
    assert.equal(closedOf([CLOSE], 'bravo'), undefined);
  });

  it('skips a damaged or newer line, and refuses to write beside a newer one', async () => {
    const files = new MemoryFiles();
    const damaged = JSON.stringify({ v: SESSION_LOG_FORMAT, ...CLOSE, freedMb: 'lots' });
    const newer = JSON.stringify({ v: SESSION_LOG_FORMAT + 1, ...CLOSE });
    await files.write(PATH, `${damaged}\nnot json\n${JSON.stringify({ v: SESSION_LOG_FORMAT, ...RESUMED })}\n${newer}`);
    const log = new SessionLog(files, PATH);
    assert.deepEqual(await log.read(), { records: [RESUMED], skipped: 3 });
    await assert.rejects(log.append(CLOSE), NewerDataError);
  });

  it('reads the text the log wrote as the log reads its file, with no file at all (T1725)', async () => {
    const files = new MemoryFiles();
    const log = new SessionLog(files, PATH);
    for (const record of [CLOSE, RESUMED]) {
      await log.append(record);
    }
    const newer = JSON.stringify({ v: SESSION_LOG_FORMAT + 1, ...CLOSE });
    const text = `${files.get(PATH) ?? ''}{torn\n${newer}\n`;
    assert.deepEqual(readSessionLog(text), { records: [CLOSE, RESUMED], skipped: 2 });
    assert.deepEqual(readSessionLog(''), { records: [], skipped: 0 });
  });
});
