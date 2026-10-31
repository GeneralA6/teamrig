import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NewerDataError } from '../core/jsonl.ts';
import { TimeZone } from '../core/zone.ts';
import { fieldPaths } from '../testing/field-paths.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { activeCut, CUT_FORMAT, CutLog, cutClause, cutText, decideCut, parseCut, type Cut, type CutDecision, type CutRequest } from './cut.ts';
import type { Lift } from './lift.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const DAY_END = Date.parse('2030-01-09T00:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const REQUEST: CutRequest = { session: 'alpha', until: undefined, reason: 'over its part twice this week', by: 'lead', now: NOW };

function refusal(decision: CutDecision): string {
  assert.equal(decision.kind, 'refused');
  return decision.kind === 'refused' ? decision.reason : '';
}

function given(decision: CutDecision): Cut {
  assert.equal(decision.kind, 'cut', decision.kind === 'refused' ? decision.reason : '');
  if (decision.kind !== 'cut') {
    throw new Error('refused');
  }
  return decision.cut;
}

function cut(overrides: Partial<Cut> = {}): Cut {
  return { session: 'alpha', endsAt: DAY_END, reason: 'over its part twice this week', by: 'lead', at: NOW, ...overrides };
}

function lift(overrides: Partial<Lift> = {}): Lift {
  return { session: 'alpha', group: false, partPct: 40, stopPct: 97, endsAt: DAY_END, reserve: false, quietHoursExempt: true, reason: 'release week', by: 'lead', at: NOW, ...overrides };
}

describe('decideCut', () => {
  it('cuts until the end of the budget day', () => {
    assert.deepEqual(given(decideCut(REQUEST, TimeZone.UTC)), cut());
  });

  it('ends at --until when it comes before the end of the day, never after it', () => {
    const until = Date.parse('2030-01-08T18:00:00Z');
    assert.equal(given(decideCut({ ...REQUEST, until }, TimeZone.UTC)).endsAt, until);
    assert.equal(given(decideCut({ ...REQUEST, until: DAY_END + 5 * MINUTE }, TimeZone.UTC)).endsAt, DAY_END);
  });

  it("refuses a passed --until, named on the team's clock", () => {
    assert.match(refusal(decideCut({ ...REQUEST, until: NOW }, TimeZone.UTC)), /^--until 2030-01-08 10:00 UTC has passed$/);
    assert.match(refusal(decideCut({ ...REQUEST, until: NOW - MINUTE }, JERUSALEM)), /^--until 2030-01-08 11:59 IST has passed$/);
  });
});

describe('activeCut', () => {
  it('is the newest cut of the session given by now, until it ends', () => {
    const older = cut({ reason: 'older', at: NOW - 2 * HOUR });
    const newer = cut({ reason: 'newer', at: NOW - HOUR, endsAt: NOW + HOUR });
    const later = cut({ reason: 'later', at: NOW + MINUTE });
    const other = cut({ session: 'bravo' });
    const cuts = [older, newer, later, other];
    assert.equal(activeCut(cuts, [], 'alpha', NOW), newer);
    assert.equal(activeCut(cuts, [], 'alpha', NOW + MINUTE - 1), newer);
    assert.equal(activeCut(cuts, [], 'alpha', NOW + MINUTE), later);
    assert.equal(activeCut([older, newer], [], 'alpha', NOW + HOUR - 1), newer);
    assert.equal(activeCut(cuts, [], 'charlie', NOW), undefined);
  });

  it('ends at its time, and a newer cut that has ended leaves no older one in force', () => {
    const older = cut({ at: NOW - 2 * HOUR });
    const short = cut({ at: NOW - HOUR, endsAt: NOW });
    assert.equal(activeCut([older], [], 'alpha', DAY_END), undefined);
    assert.equal(activeCut([older, short], [], 'alpha', NOW), undefined);
  });

  it('is ended by a lift of the session given after it, not by one given before it', () => {
    const inForce = cut({ at: NOW - HOUR });
    assert.equal(activeCut([inForce], [lift({ at: NOW - 2 * HOUR })], 'alpha', NOW), inForce);
    assert.equal(activeCut([inForce], [lift({ at: NOW - HOUR })], 'alpha', NOW), inForce);
    assert.equal(activeCut([inForce], [lift({ at: NOW - 30 * MINUTE })], 'alpha', NOW), undefined);
  });

  it("is not ended by a lift still to come, another session's lift or a lift of the group the session leads", () => {
    const inForce = cut({ at: NOW - HOUR });
    assert.equal(activeCut([inForce], [lift({ at: NOW + MINUTE })], 'alpha', NOW), inForce);
    assert.equal(activeCut([inForce], [lift({ session: 'bravo', at: NOW - 30 * MINUTE })], 'alpha', NOW), inForce);
    assert.equal(activeCut([inForce], [lift({ group: true, quietHoursExempt: false, at: NOW - 30 * MINUTE })], 'alpha', NOW), inForce);
  });
});

describe('cutText', () => {
  it('says what the cut does and when it ends', () => {
    assert.equal(
      cutText(cut(), 'alpha', TimeZone.UTC),
      'alpha to its own daily budget until 00:00 UTC (the end of the budget day): past it, it is held whatever room the team has, ' +
        'so it wakes for p0 work only and budget.overAction holds its new helpers back as it says; a lift in force still sets that budget, and a new lift of it ends the cut.',
    );
  });

  it("says when it ends on the team's clock", () => {
    assert.match(cutText(cut({ endsAt: Date.parse('2030-01-08T16:00:00Z') }), 'alpha', JERUSALEM), /^alpha to its own daily budget until 18:00 IST: past it, /);
  });
});

describe('cutClause', () => {
  it('names the leader that gave the cut and when it ends', () => {
    assert.equal(cutClause(cut(), 'its leader app-bravo', TimeZone.UTC), 'its leader app-bravo cut it to its own daily budget until 00:00 UTC (the end of the budget day)');
    assert.equal(cutClause(cut({ endsAt: Date.parse('2030-01-08T16:00:00Z') }), 'the lead', JERUSALEM), 'the lead cut it to its own daily budget until 18:00 IST');
  });
});

describe('parseCut', () => {
  const record = { session: 'alpha', endsAt: '2030-01-09T00:00:00.000Z', reason: 'over its part twice this week', by: 'lead', at: '2030-01-08T10:00:00.000Z' };

  it('reads a whole record', () => {
    assert.deepEqual(parseCut(record), cut());
  });

  it('skips a damaged one', () => {
    const damages = [{ session: 3 }, { endsAt: 'soon' }, { endsAt: undefined }, { at: 5 }, { reason: undefined }, { by: null }];
    for (const damage of damages) {
      assert.equal(parseCut({ ...record, ...damage }), undefined, JSON.stringify(damage));
    }
  });
});

describe('CutLog', () => {
  const PATH = '/kit/teams/app/state/usage/cuts.jsonl';

  it('appends whole lines and reads them back, skipping damaged ones', async () => {
    const files = new MemoryFiles({ [PATH]: '{"v":1,"session":"alpha"}' });
    const log = new CutLog(files, PATH);
    await log.append(cut());
    await log.append(cut({ session: 'bravo', endsAt: NOW + HOUR }));
    assert.deepEqual(await log.read(), { cuts: [cut(), cut({ session: 'bravo', endsAt: NOW + HOUR })], skipped: 1 });
    assert.equal((await files.read(PATH))?.split('\n').filter((line) => line !== '').length, 3);
  });

  it('starts a missing log, and refuses to write beside a newer teamrig', async () => {
    const empty = new CutLog(new MemoryFiles(), PATH);
    assert.deepEqual(await empty.read(), { cuts: [], skipped: 0 });
    await empty.append(cut());
    assert.equal((await empty.read()).cuts.length, 1);
    const newer = new CutLog(new MemoryFiles({ [PATH]: `{"v":${CUT_FORMAT + 1},"session":"alpha"}\n` }), PATH);
    assert.deepEqual(await newer.read(), { cuts: [], skipped: 1 });
    await assert.rejects(newer.append(cut()), NewerDataError);
  });

  it('writes the pinned fields of its format: a field added to a cut raises CUT_FORMAT', async () => {
    const written: Readonly<Record<number, readonly string[]>> = {
      1: ['at', 'by', 'endsAt', 'reason', 'session', 'v'],
    };
    const files = new MemoryFiles();
    await new CutLog(files, PATH).append(cut());
    assert.deepEqual(fieldPaths(JSON.parse(files.get(PATH) ?? '')), written[CUT_FORMAT]);
  });
});
