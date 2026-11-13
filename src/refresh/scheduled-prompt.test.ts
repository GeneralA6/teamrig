import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import { endsWithScheduledFire, firedBySchedule } from './scheduled-prompt.ts';

const lines = (...entries: readonly object[]): string => `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
const FIRE = { type: 'system', subtype: 'scheduled_task_fire', content: 'Running scheduled task (Nov 11 8:47am)', taskId: 'job1', prompt: 'check the inbox' };
const TURN_END = { type: 'system', subtype: 'turn_duration', durationMs: 1200 };
const REPLY = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };

describe('a prompt fired by a scheduled job', () => {
  it('is told by the fire entry that ends the transcript when the hook runs', () => {
    assert.equal(endsWithScheduledFire(lines(REPLY, TURN_END, { type: 'queue-operation', operation: 'enqueue' }, FIRE)), true);
  });
  it('is not a typed prompt, whose transcript ends with the last turn', () => {
    assert.equal(endsWithScheduledFire(lines(FIRE, { type: 'user', message: { content: 'check the inbox' } }, REPLY, TURN_END)), false);
    assert.equal(endsWithScheduledFire(''), false);
    assert.equal(endsWithScheduledFire('{not json\n'), false);
  });
  it('reads the transcript, and is false when there is none', async () => {
    const files = new MemoryFiles();
    await files.write('/t.jsonl', lines(REPLY, FIRE));
    assert.equal(await firedBySchedule(files, '/t.jsonl'), true);
    assert.equal(await firedBySchedule(files, '/missing.jsonl'), false);
    assert.equal(await firedBySchedule(files, undefined), false);
  });
});
