import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { firstHint, JsonlHintLog } from './hint-log.ts';

const LOG = 'state/bind-hints.jsonl';
const TAB = '0a1b2c3d-1111-2222-3333-444455556666';
const OTHER_TAB = '9f8e7d6c-1111-2222-3333-444455556666';
const NOW = new Date('2030-01-08T10:00:00Z');

describe('firstHint', () => {
  it('lets each reason through once per Claude Code session, and records it', async () => {
    const files = new MemoryFiles();
    const log = new JsonlHintLog(files, LOG);
    assert.equal(await firstHint(log, TAB, 'untitled', NOW), true);
    assert.equal(await firstHint(log, TAB, 'untitled', NOW), false);
    assert.equal(await firstHint(log, TAB, 'unmatched:Fix it', NOW), true);
    assert.equal(await firstHint(log, OTHER_TAB, 'untitled', NOW), true);
    assert.equal(files.get(LOG)?.split('\n')[0], `{"v":1,"claudeSession":"${TAB}","reason":"untitled","at":"${NOW.toISOString()}"}`);
  });

  it('counts a line from a newer teamrig, and skips damaged lines', async () => {
    const files = new MemoryFiles({ [LOG]: `not json\n{"v":2,"claudeSession":"${TAB}","reason":"untitled"}\n` });
    assert.equal(await firstHint(new JsonlHintLog(files, LOG), TAB, 'untitled', NOW), false);
  });

  it('lets the hint through when the log cannot be read or written', async () => {
    const memory = new MemoryFiles();
    const unreadable = new FaultyFiles(memory).fail('read', LOG, systemError('EBUSY'));
    assert.equal(await firstHint(new JsonlHintLog(unreadable, LOG), TAB, 'untitled', NOW), true);
    const unwritable = new FaultyFiles(memory).fail('append', LOG, systemError('EACCES'));
    assert.equal(await firstHint(new JsonlHintLog(unwritable, LOG), TAB, 'untitled', NOW), true);
    assert.equal(await firstHint(new JsonlHintLog(unwritable, LOG), TAB, 'untitled', NOW), true);
  });
});
