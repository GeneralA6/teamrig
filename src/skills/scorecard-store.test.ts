import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NewerDataError } from '../core/jsonl.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { EMPTY_TALLY, type ScorecardState } from './scorecard.ts';
import { formatScorecard, SCORECARD_FORMAT, ScorecardStore } from './scorecard-store.ts';

const PATH = '/kit/teams/app/state/skills-scorecard.json';
const STATE: ScorecardState = {
  since: '2030-01-01',
  days: { '2030-01-08': { 'alpha-ship': { loads: 2, skill: { runs: 1, calls: 4, failed: 1, refused: 0 }, manual: EMPTY_TALLY, edits: 1 } } },
  cursors: {
    '/c/p/app/s1.jsonl': {
      offset: 120,
      size: 130,
      lastAt: 1_893_000_000_000,
      calls: 7,
      lastLoad: { 'alpha-ship': 3 },
      open: [{ skill: 'alpha-ship', mode: 'manual', day: '2030-01-08', calls: 2, failed: 0, refused: 1 }],
    },
  },
};

function storeWith(text: string | undefined): ScorecardStore {
  return new ScorecardStore(new MemoryFiles(text === undefined ? {} : { [PATH]: text }), PATH);
}

/** The saved state with one field replaced, as a damaged write or a hand edit would leave it. */
function changed(edit: (record: Record<string, unknown>) => void): string {
  const record: Record<string, unknown> = JSON.parse(formatScorecard(STATE));
  edit(record);
  return JSON.stringify(record);
}

describe('ScorecardStore', () => {
  it('saves the state and reads it back', async () => {
    const files = new MemoryFiles();
    const store = new ScorecardStore(files, PATH);
    await store.save(STATE);
    assert.deepEqual(await store.load(), STATE);
    assert.match(files.get(PATH) ?? '', new RegExp(`^\\{"v":${SCORECARD_FORMAT},`));
  });

  it('reads no state when there is none, or it is damaged or in an older format', async () => {
    assert.equal(await storeWith(undefined).load(), undefined);
    assert.equal(await storeWith('{"v":1,').load(), undefined);
    assert.equal(await storeWith(changed((record) => delete record['v'])).load(), undefined);
    assert.equal(await storeWith(changed((record) => (record['v'] = 'x'))).load(), undefined);
  });

  it('reads no state when any part of it is damaged', async () => {
    const cursor = (edit: (fields: Record<string, unknown>) => void): string =>
      changed((record) => {
        const fields = { ...STATE.cursors['/c/p/app/s1.jsonl'] };
        edit(fields);
        record['cursors'] = { '/c/p/app/s1.jsonl': fields };
      });
    const damaged = [
      changed((record) => (record['since'] = 'yesterday')),
      changed((record) => (record['days'] = { 'not-a-day': {} })),
      changed((record) => (record['days'] = { '2030-01-08': { 'alpha-ship': { loads: -1, skill: EMPTY_TALLY, manual: EMPTY_TALLY, edits: 0 } } })),
      changed((record) => (record['days'] = { '2030-01-08': { 'alpha-ship': { loads: 1, skill: { runs: 1 }, manual: EMPTY_TALLY, edits: 0 } } })),
      changed((record) => (record['days'] = { '2030-01-08': { 'alpha-ship': 'x' } })),
      changed((record) => (record['cursors'] = { '': STATE.cursors['/c/p/app/s1.jsonl'] })),
      changed((record) => (record['cursors'] = [])),
      cursor((fields) => (fields['open'] = 'none')),
      cursor((fields) => (fields['open'] = [{ skill: 'alpha-ship', mode: 'auto', day: '2030-01-08', calls: 0, failed: 0, refused: 0 }])),
      cursor((fields) => (fields['open'] = [{ skill: '', mode: 'skill', day: '2030-01-08', calls: 0, failed: 0, refused: 0 }])),
      cursor((fields) => (fields['open'] = ['x'])),
      cursor((fields) => (fields['lastLoad'] = { 'alpha-ship': 1.5 })),
      cursor((fields) => (fields['lastAt'] = null)),
      changed((record) => (record['cursors'] = { '/c/p/app/s1.jsonl': 'x' })),
    ];
    for (const text of damaged) {
      assert.equal(await storeWith(text).load(), undefined, text);
    }
  });

  it('refuses a state a newer teamrig wrote, so this one never overwrites it', async () => {
    await assert.rejects(storeWith(changed((record) => (record['v'] = SCORECARD_FORMAT + 1))).load(), NewerDataError);
  });
});
