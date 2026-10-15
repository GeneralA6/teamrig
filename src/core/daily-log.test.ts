import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import { DAILY_LOG_VERSION, JsonlDailyLog } from './daily-log.ts';

const PATH = 'state/notices.jsonl';
const MORNING = new Date('2030-01-08T08:00:00.000Z');
const EVENING = new Date('2030-01-08T23:59:00.000Z');
const NEXT_DAY = new Date('2030-01-09T00:00:00.000Z');

describe('JsonlDailyLog', () => {
  it('sees a key on the UTC day it was recorded, and on no other', async () => {
    const files = new MemoryFiles();
    const log = new JsonlDailyLog(files, PATH);
    assert.equal(await log.seen('gate T2 T1', MORNING), false, 'no file yet');
    await log.record('gate T2 T1', MORNING);
    assert.deepEqual([await log.seen('gate T2 T1', EVENING), await log.seen('gate T3 T1', EVENING)], [true, false]);
    assert.equal(await log.seen('gate T2 T1', NEXT_DAY), false);
  });

  it('keeps one day of lines, a newer line of that day included, and skips damaged ones', async () => {
    const files = new MemoryFiles({ [PATH]: '{"v":1,"day":"2030-01-07","key":"old"}\n{"v":9,"day":"2030-01-08","key":"newer","extra":1}\nnot json\n' });
    const log = new JsonlDailyLog(files, PATH);
    await log.record('fresh', MORNING);
    assert.equal(
      files.get(PATH),
      `{"v":9,"day":"2030-01-08","key":"newer","extra":1}\n{"v":${DAILY_LOG_VERSION},"day":"2030-01-08","key":"fresh"}\n`,
    );
    assert.equal(await log.seen('newer', MORNING), true);
  });
});
