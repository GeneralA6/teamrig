import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryFiles } from '../testing/memory-files.ts';
import type { ScheduledMeeting } from './schedule.ts';
import { parseSpotlit, SPOTLIT_GRACE_MS, SpotlitStore, spotlitUntil } from './spotlit.ts';

const PATH = 'state/meeting-spotlit.json';
const STARTED = '2030-01-08T14:02:00.000Z';
const ENDED = '2030-01-08T14:30:00.000Z';

const MEETING: ScheduledMeeting = {
  id: 'M3',
  at: Date.parse('2030-01-08T14:00:00Z'),
  minutes: 20,
  session: 'web',
  with: [],
  tasks: [],
  about: 'the pricing tiers',
  brief: null,
  status: 'started',
  notifiedAt: null,
  by: 'lead',
  changedAt: 0,
  note: null,
};

describe('spotlitUntil', () => {
  it('lifts the spotlight its minutes and a quarter hour after its start, not its booked slot', () => {
    assert.equal(SPOTLIT_GRACE_MS, 15 * 60_000);
    assert.equal(spotlitUntil(MEETING, Date.parse(STARTED)), Date.parse('2030-01-08T14:37:00.000Z'));
  });
});

describe('SpotlitStore', () => {
  it('writes the started meeting in the shape the spotlight script reads, then sets its end', async () => {
    const files = new MemoryFiles();
    const store = new SpotlitStore(files, PATH);
    await store.start('M3', STARTED);
    assert.deepEqual(JSON.parse((await files.read(PATH)) ?? ''), { id: 'M3', startedAt: STARTED, endedAt: null });
    assert.equal(await store.end('M3', ENDED), true);
    assert.deepEqual(await store.read(), { id: 'M3', startedAt: STARTED, endedAt: ENDED });
    assert.equal(await store.end('M3', '2030-01-08T15:00:00.000Z'), false, 'an ended meeting keeps its first end');
    assert.equal((await store.read())?.endedAt, ENDED);
  });

  it("leaves another meeting's spotlight on, and ends nothing with no file", async () => {
    const files = new MemoryFiles();
    const store = new SpotlitStore(files, PATH);
    assert.equal(await store.end('M3', ENDED), false);
    assert.equal(await files.read(PATH), undefined);
    await store.start('M4', STARTED);
    assert.equal(await store.end('M3', ENDED), false);
    assert.deepEqual(await store.read(), { id: 'M4', startedAt: STARTED, endedAt: null });
  });
});

describe('parseSpotlit', () => {
  it('reads nothing from a damaged file', () => {
    assert.equal(parseSpotlit('not json'), undefined);
    assert.equal(parseSpotlit('{"id":"M3"}'), undefined);
    assert.equal(parseSpotlit('{"id":"M3","startedAt":"x","endedAt":5}'), undefined);
  });
});
