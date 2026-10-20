import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Meeting } from '../meeting/state.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { askedAtOf, AskedStore, formatAskedBatch, parseAskedBatch, type AskedBatch } from './store.ts';

const ASKED: AskedBatch = { askedAt: '2030-01-08T13:10:00.000Z', by: 'lead', ids: ['T4', 'T9'] };
const MEETING: Meeting = { startedAt: '2030-01-08T09:30:00.000Z', by: 'lead', endedAt: '2030-01-08T09:50:00.000Z', since: null };

describe('the asked batch file', () => {
  it('reads back what it writes', () => {
    assert.deepEqual(parseAskedBatch(formatAskedBatch(ASKED)), ASKED);
  });

  it('reads a damaged file, another format or a bad field as no batch asked', () => {
    assert.equal(parseAskedBatch('{not json'), undefined);
    assert.equal(parseAskedBatch(JSON.stringify({ v: 2, askedAt: ASKED.askedAt, by: 'lead', ids: [] })), undefined);
    assert.equal(parseAskedBatch(JSON.stringify({ v: 1, askedAt: 'soon', by: 'lead', ids: [] })), undefined);
    assert.equal(parseAskedBatch(JSON.stringify({ v: 1, askedAt: ASKED.askedAt, ids: [] })), undefined);
    assert.equal(parseAskedBatch(JSON.stringify({ v: 1, askedAt: ASKED.askedAt, by: 'lead', ids: [4] })), undefined);
  });

  it('keeps the last batch in one file, none before the first', async () => {
    const files = new MemoryFiles();
    const store = new AskedStore(files, '/kit/state/decisions-asked.json');
    assert.equal(await store.read(), undefined);
    await store.write(ASKED);
    assert.deepEqual(await store.read(), ASKED);
    assert.equal(await files.read('/kit/state/decisions-asked.json'), formatAskedBatch(ASKED));
  });
});

describe('when the lead last asked a batch', () => {
  it('is the later of the last batch asked and the last meeting start, or never', () => {
    assert.equal(askedAtOf(ASKED, MEETING), Date.parse(ASKED.askedAt));
    assert.equal(askedAtOf({ ...ASKED, askedAt: '2030-01-08T08:00:00.000Z' }, MEETING), Date.parse(MEETING.startedAt));
    assert.equal(askedAtOf(undefined, MEETING), Date.parse(MEETING.startedAt));
    assert.equal(askedAtOf(ASKED, undefined), Date.parse(ASKED.askedAt));
    assert.equal(askedAtOf(undefined, undefined), undefined);
  });
});
