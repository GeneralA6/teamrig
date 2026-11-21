import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PlainLogFile } from '../core/log-file.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { MARK_VERSION, type InboxMark } from './marks.ts';
import { JsonlMarkLog } from './store.ts';

const MARKS = join('team', 'state', 'inbox-marks.jsonl');
const SESSION = '0a1b2c3d-1111-2222-3333-444455556666';

describe('JsonlMarkLog', () => {
  it('writes a mark as the very line every installed teamrig reads, and reads it back (T4762)', async () => {
    const files = new MemoryFiles();
    const log = new JsonlMarkLog(new PlainLogFile(files, MARKS));
    const mark: InboxMark = { v: MARK_VERSION, area: 'alpha', line: 3, at: '2030-01-07T09:00:00.000Z', claudeSession: SESSION, lastLineHash: 'abcd' };
    await log.append(mark);
    // The store writes the mark's own keys, so a renamed property renames the key on disk: this line may change
    // only in the commit that raises the written format.
    assert.equal(files.get(MARKS), `{"v":1,"area":"alpha","line":3,"at":"2030-01-07T09:00:00.000Z","claudeSession":"${SESSION}","lastLineHash":"abcd"}\n`);
    assert.deepEqual(await log.read(), { marks: [mark], unreadable: 0, newer: 0 });
  });

  it('reads a mark a later teamrig wrote beside its own, and counts one newer still (T4762)', async () => {
    const files = new MemoryFiles();
    const log = new JsonlMarkLog(new PlainLogFile(files, MARKS));
    const later = { v: 2, area: 'alpha', line: 4, at: '2030-01-07T10:00:00.000Z', hostSession: SESSION, lastLineHash: 'ef01' };
    await files.write(MARKS, `${JSON.stringify(later)}\n${JSON.stringify({ ...later, v: 3 })}\n`);
    const { hostSession, ...rest } = later;
    assert.deepEqual(await log.read(), { marks: [{ ...rest, claudeSession: hostSession }], unreadable: 0, newer: 1 });
  });
});
