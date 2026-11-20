import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import { endsWithScheduledFire, firedBySchedule } from './scheduled-prompt.ts';

const lines = (...entries: readonly object[]): string => `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
const FIRE = { type: 'system', subtype: 'scheduled_task_fire', content: 'Running scheduled task (Nov 11 8:47am)', taskId: 'job1', prompt: 'check the inbox' };
const TURN_END = { type: 'system', subtype: 'turn_duration', durationMs: 1200 };
const NOW = Date.parse('2026-11-11T13:47:00Z');
const CRON_CALL = { type: 'assistant', isSidechain: false, timestamp: new Date(NOW - 60_000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_cron', name: 'CronCreate', input: { cron: '*/10 * * * *', prompt: 'check the inbox', recurring: true } }] } };
const CRON_RESULT = { type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_cron', content: 'ok' }] }, toolUseResult: { id: 'job1', humanSchedule: '*/10 * * * *', recurring: true, durable: false } };
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
  it('is a live job\'s prompt: one the transcript made, or one a /clear left in the process', async () => {
    const files = new MemoryFiles();
    const job = { id: 'job1', cron: '*/10 * * * *', prompt: 'check the inbox', recurring: true, createdAt: NOW - 60_000 };
    const seen = { transcript: '/t.jsonl', prompt: 'check the inbox' };
    await files.write('/t.jsonl', lines(CRON_CALL, CRON_RESULT, REPLY, FIRE));
    assert.equal(await firedBySchedule(files, seen, [], NOW), true, 'made in this transcript');
    await files.write('/t.jsonl', lines(REPLY, FIRE));
    assert.equal(await firedBySchedule(files, seen, [job], NOW), true, 'inherited through a /clear');
    assert.equal(await firedBySchedule(files, seen, [], NOW), false, 'no live job has that prompt');
  });
  it('is not a person typing after a folded fire: the prompt matches no live job', async () => {
    const files = new MemoryFiles();
    await files.write('/t.jsonl', lines(CRON_CALL, CRON_RESULT, REPLY, FIRE));
    assert.equal(await firedBySchedule(files, { transcript: '/t.jsonl', prompt: 'one more thing' }, [], NOW), false);
    assert.equal(await firedBySchedule(files, { transcript: '/t.jsonl', prompt: undefined }, [], NOW), false);
  });
  it('is false with no transcript, or one that does not end with a fire', async () => {
    const files = new MemoryFiles();
    await files.write('/t.jsonl', lines(CRON_CALL, CRON_RESULT, FIRE, REPLY));
    assert.equal(await firedBySchedule(files, { transcript: '/t.jsonl', prompt: 'check the inbox' }, [], NOW), false);
    assert.equal(await firedBySchedule(files, { transcript: '/missing.jsonl', prompt: 'check the inbox' }, [], NOW), false);
    assert.equal(await firedBySchedule(files, { transcript: undefined, prompt: 'check the inbox' }, [], NOW), false);
  });
});
