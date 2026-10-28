import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LookSchedule } from './look-schedule.ts';

const RECHECK = 600_000;
const FILE = '/kit/teams/app/state/meetings.jsonl';

/** A schedule over one file whose change time the test sets. */
function scheduleOf(): { readonly looks: LookSchedule; readonly file: { changed: number | undefined } } {
  const file: { changed: number | undefined } = { changed: 5 };
  return { looks: new LookSchedule(RECHECK, async (path) => (path === FILE ? file.changed : undefined)), file };
}

describe('LookSchedule', () => {
  it('asks at the first look, then once more when the CLI first names its files, then only on a change', async () => {
    const { looks, file } = scheduleOf();
    assert.equal(await looks.due(0), true);
    looks.waitFor([FILE], null);
    assert.equal(looks.watching, true);
    assert.equal(await looks.due(1), true, 'the files first named: their change times are taken');
    looks.waitFor([FILE], null);
    assert.equal(await looks.due(2), false);
    file.changed = 9;
    assert.equal(await looks.due(3), true);
    assert.equal(await looks.due(4), false, 'a change is asked about once');
  });

  it('asks at the time the CLI named, and RECHECK after the last ask with nothing named', async () => {
    const { looks } = scheduleOf();
    await looks.due(0);
    looks.waitFor([FILE], null);
    await looks.due(0);
    looks.waitFor([FILE], 50_000);
    assert.equal(await looks.due(49_999), false);
    assert.equal(await looks.due(50_000), true);
    looks.waitFor([FILE], null);
    assert.equal(await looks.due(50_000 + RECHECK - 1), false);
    assert.equal(await looks.due(50_000 + RECHECK), true);
  });

  it('asks again at once when other files are named, or when told to', async () => {
    const { looks } = scheduleOf();
    await looks.due(0);
    looks.waitFor([FILE], null);
    await looks.due(1);
    looks.waitFor([FILE], null);
    looks.waitFor([FILE, '/kit/teams/app/state/wake-asks/alpha'], null);
    assert.equal(await looks.due(2), true);
    looks.askAgain();
    assert.equal(await looks.due(3), true);
  });
});
