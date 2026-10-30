import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGET } from '../config/defaults.ts';
import { NewerDataError } from '../core/jsonl.ts';
import { TimeZone } from '../core/zone.ts';
import { fieldPaths } from '../testing/field-paths.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import {
  activeGroupLift,
  activeLift,
  decideLift,
  LIFT_FORMAT,
  LiftLog,
  liftedLine,
  liftText,
  parentBudgetText,
  parseLift,
  type Lift,
  type LiftContext,
  type LiftDecision,
  type LiftRequest,
} from './lift.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
/** The week's reset, Wednesday 01:00 UTC, 15 hours after `NOW`. */
const RESET = Date.parse('2030-01-09T01:00:00Z');
const DAY_END = Date.parse('2030-01-09T00:00:00Z');
const MINUTE = 60_000;

const TEAM = parentBudgetText(undefined);
const REQUEST: LiftRequest = { session: 'alpha', group: false, partPct: 40, stopPct: 97, until: undefined, reserve: false, reason: 'release week', by: 'lead', now: NOW };
const CONTEXT: LiftContext = { usedPct: 57, reset: RESET, limits: DEFAULT_BUDGET.lift, liftedPct: 0, parent: TEAM, beyondParent: undefined, zone: TimeZone.UTC };

function refusal(decision: LiftDecision): string {
  assert.equal(decision.kind, 'refused');
  return decision.kind === 'refused' ? decision.reason : '';
}

function given(decision: LiftDecision): Lift {
  assert.equal(decision.kind, 'lift', decision.kind === 'refused' ? decision.reason : '');
  if (decision.kind !== 'lift') {
    throw new Error('refused');
  }
  return decision.lift;
}

function lift(overrides: Partial<Lift> = {}): Lift {
  return { session: 'alpha', group: false, partPct: 40, stopPct: 97, endsAt: DAY_END, reserve: false, quietHoursExempt: true, reason: 'release week', by: 'lead', at: NOW, ...overrides };
}

describe('decideLift', () => {
  it('lifts until the end of the day, exempt from quiet hours', () => {
    assert.deepEqual(given(decideLift(REQUEST, CONTEXT)), lift());
  });

  it('lifts a group as a share: quiet hours still apply to its sessions', () => {
    assert.deepEqual(given(decideLift({ ...REQUEST, group: true }, CONTEXT)), lift({ group: true, quietHoursExempt: false }));
  });

  it("lifts a session of a team below without exempting it from quiet hours, which its own team's log rules", () => {
    assert.deepEqual(given(decideLift({ ...REQUEST, session: 'web/front' }, CONTEXT)), lift({ session: 'web/front', quietHoursExempt: false }));
  });

  it('ends at --until when it comes before the end of the day', () => {
    const until = Date.parse('2030-01-08T18:00:00Z');
    assert.equal(given(decideLift({ ...REQUEST, until }, CONTEXT)).endsAt, until);
    assert.equal(given(decideLift({ ...REQUEST, until: DAY_END + 5 * MINUTE }, CONTEXT)).endsAt, DAY_END);
  });

  it('refuses a lift without a stop %, or one above the team bounds', () => {
    assert.match(refusal(decideLift({ ...REQUEST, stopPct: undefined }, CONTEXT)), /needs --stop-pct/);
    assert.match(refusal(decideLift({ ...REQUEST, stopPct: 99.95 }, CONTEXT)), /above budget\.lift\.reserveStopPct \(99\.9\)/);
    assert.match(refusal(decideLift({ ...REQUEST, stopPct: 99.5 }, CONTEXT)), /above budget\.lift\.maxStopPct \(99\.3\); only the reserve release/);
    assert.equal(given(decideLift({ ...REQUEST, stopPct: 99.3 }, CONTEXT)).stopPct, 99.3);
  });

  it('refuses a part that, with the other lifts in force, would give more than the whole team budget', () => {
    assert.match(
      refusal(decideLift(REQUEST, { ...CONTEXT, liftedPct: 70 })),
      /other lifts in force give 70\.0% of the team's daily budget, so --part 40 would give more than all of it; the most this lift may give is 30\.0%/,
    );
    assert.equal(given(decideLift({ ...REQUEST, partPct: 30 }, { ...CONTEXT, liftedPct: 70 })).partPct, 30);
  });

  it("names a group parent in the refusal, followed by what to ask the leader above", () => {
    const inGroup: LiftContext = { ...CONTEXT, liftedPct: 70, parent: parentBudgetText('tr'), beyondParent: 'Ask lead for a group lift.' };
    assert.match(
      refusal(decideLift(REQUEST, inGroup)),
      /other lifts in force give 70\.0% of tr's group's daily budget, so --part 40 would give more than all of it; the most this lift may give is 30\.0%\. Ask lead for a group lift\.$/,
    );
  });

  it('refuses a passed --until, an unknown week and a week already at the stop %', () => {
    assert.match(refusal(decideLift({ ...REQUEST, until: NOW }, CONTEXT)), /--until 2030-01-08 10:00 UTC has passed/);
    assert.match(refusal(decideLift({ ...REQUEST, until: NOW }, { ...CONTEXT, zone: JERUSALEM })), /--until 2030-01-08 12:00 IST has passed/);
    assert.match(refusal(decideLift(REQUEST, { ...CONTEXT, usedPct: undefined })), /use is unknown/);
    assert.match(refusal(decideLift(REQUEST, { ...CONTEXT, usedPct: 97 })), /already at or past --stop-pct 97/);
  });

  it('releases the reserve only in the last hour before the reset, ending 15 minutes before it', () => {
    const reserve: LiftRequest = { ...REQUEST, stopPct: 99.9, reserve: true };
    assert.match(refusal(decideLift(reserve, { ...CONTEXT, reset: undefined })), /--reserve needs the week's reset/);
    assert.match(refusal(decideLift(reserve, CONTEXT)), /only in the last hour before the reset, from 2030-01-09 00:00 UTC/);
    const inTime = given(decideLift({ ...reserve, now: RESET - 30 * MINUTE }, { ...CONTEXT, usedPct: 99.4 }));
    assert.deepEqual([inTime.endsAt, inTime.reserve], [RESET - 15 * MINUTE, true]);
    const late = decideLift({ ...reserve, now: RESET - 10 * MINUTE }, { ...CONTEXT, usedPct: 99.4 });
    assert.match(refusal(late), /ends 15 minutes before the reset, at 2030-01-09 00:45 UTC, which has passed/);
  });
});

describe('activeLift', () => {
  it('is the newest lift given by now, until its end or the stop %', () => {
    const older = lift({ partPct: 15, at: NOW - 2 * 60 * MINUTE });
    const newer = lift({ partPct: 30, at: NOW - 60 * MINUTE });
    const later = lift({ partPct: 90, at: NOW + MINUTE });
    const other = lift({ session: 'bravo' });
    const lifts = [older, newer, later, other];
    assert.equal(activeLift(lifts, 'alpha', NOW, 57), newer);
    assert.equal(activeLift(lifts, 'alpha', NOW, undefined), newer);
    assert.equal(activeLift(lifts, 'alpha', NOW, 97), undefined);
    assert.equal(activeLift(lifts, 'alpha', DAY_END, 57), undefined);
    assert.equal(activeLift(lifts, 'charlie', NOW, 57), undefined);
  });

  it("keeps a sub-lead's own lift apart from its group's", () => {
    const own = lift({ partPct: 20, at: NOW - 2 * 60 * MINUTE });
    const group = lift({ group: true, partPct: 50, at: NOW - 60 * MINUTE });
    assert.equal(activeLift([own, group], 'alpha', NOW, 57), own);
    assert.equal(activeGroupLift([own, group], 'alpha', NOW, 57), group);
    assert.equal(activeGroupLift([own], 'alpha', NOW, 57), undefined);
    assert.equal(activeGroupLift([group], 'alpha', NOW, 97), undefined);
  });
});

describe('liftText', () => {
  it('says what the lift gives and when it ends', () => {
    assert.equal(
      liftText(lift(), 'alpha', TEAM, TimeZone.UTC),
      "alpha to 40.0% of the team's daily budget today until 00:00 UTC (the end of the budget day) or 97.0% of the week, whichever comes first; quiet hours do not apply to it.",
    );
    assert.equal(
      liftText(lift({ partPct: 100, reserve: true, endsAt: RESET - 15 * MINUTE, stopPct: 99.9 }), 'alpha', TEAM, TimeZone.UTC),
      "alpha to 100.0% of the team's daily budget today from the reserve until 00:45 UTC or 99.9% of the week, whichever comes first; quiet hours do not apply to it.",
    );
  });

  it("names a group and a group parent; a group lift leaves quiet hours in place", () => {
    assert.equal(
      liftText(lift({ group: true, quietHoursExempt: false }), 'alpha', TEAM, TimeZone.UTC),
      "alpha's group to 40.0% of the team's daily budget today until 00:00 UTC (the end of the budget day) or 97.0% of the week, whichever comes first.",
    );
    assert.match(liftText(lift(), 'bravo', parentBudgetText('alpha'), TimeZone.UTC), /^bravo to 40\.0% of alpha's group's daily budget today until /);
  });

  it("gives a cross-team lift's part on top of the session's own budget", () => {
    assert.equal(
      liftText(lift({ session: 'web/front', quietHoursExempt: false }), 'web/front', "team app's daily budget", TimeZone.UTC),
      "web/front to 40.0% of team app's daily budget on top of its own budget today until 00:00 UTC (the end of the budget day) or 97.0% of the week, whichever comes first.",
    );
  });

  it("says when it ends on the team's clock", () => {
    assert.match(liftText(lift(), 'alpha', TEAM, JERUSALEM), /^alpha to 40\.0% of the team's daily budget today until 02:00 IST \(the end of the budget day\) or 97\.0% of the week, /);
  });
});

describe('liftedLine', () => {
  it('names the leader that lifted the session and the budget the lift is a part of', () => {
    assert.match(liftedLine(lift({ by: 'bravo' }), 'charlie', { liftBy: 'app-bravo', liftParent: 'app-bravo' }, TimeZone.UTC), /^Budget: app-bravo lifted charlie to 40\.0% of app-bravo's group's daily budget today /);
  });

  it('names the leader by its id when its name is not known', () => {
    assert.match(liftedLine(lift({ by: 'bravo' }), 'charlie', { liftBy: undefined, liftParent: undefined }, TimeZone.UTC), /^Budget: bravo lifted charlie to 40\.0% of the team's daily budget today /);
  });
});

describe('parseLift', () => {
  const record = {
    session: 'alpha',
    partPct: 40,
    stopPct: 97,
    endsAt: '2030-01-09T00:00:00.000Z',
    reserve: false,
    quietHoursExempt: true,
    reason: 'release week',
    by: 'lead',
    at: '2030-01-08T10:00:00.000Z',
  };

  it('reads a whole record', () => {
    assert.deepEqual(parseLift({ ...record, group: false }, LIFT_FORMAT), lift());
    assert.deepEqual(parseLift({ ...record, group: true, quietHoursExempt: false }, LIFT_FORMAT), lift({ group: true, quietHoursExempt: false }));
  });

  it('reads a format 2 record, written before group lifts, as a session lift', () => {
    assert.deepEqual(parseLift(record, 2), lift());
    assert.deepEqual(parseLift({ ...record, group: true }, 2), lift());
  });

  it('skips a damaged one', () => {
    const damages = [
      { session: 3 },
      { group: 'no' },
      { group: undefined },
      { partPct: 0 },
      { stopPct: 101 },
      { partPct: Number.NaN },
      { endsAt: 'soon' },
      { at: 5 },
      { reserve: 'no' },
      { quietHoursExempt: null },
      { reason: undefined },
      { by: undefined },
    ];
    for (const damage of damages) {
      assert.equal(parseLift({ ...record, group: false, ...damage }, LIFT_FORMAT), undefined, JSON.stringify(damage));
    }
  });
});

describe('LiftLog', () => {
  const PATH = '/kit/teams/app/state/usage/lifts.jsonl';

  it('appends whole lines and reads them back, skipping damaged ones', async () => {
    const files = new MemoryFiles({ [PATH]: '{"v":1,"session":"alpha"}' });
    const log = new LiftLog(files, PATH);
    await log.append(lift());
    await log.append(lift({ session: 'bravo', group: true, reserve: true }));
    const read = await log.read();
    assert.deepEqual(read, { lifts: [lift(), lift({ session: 'bravo', group: true, reserve: true })], skipped: 1 });
    assert.equal((await files.read(PATH))?.split('\n').filter((line) => line !== '').length, 3);
  });

  it('reads the format 2 lifts in force at the upgrade as session lifts, and appends beside them', async () => {
    const formatTwo =
      '{"v":2,"session":"alpha","partPct":40,"stopPct":97,"endsAt":"2030-01-09T00:00:00.000Z","reserve":false,' +
      '"quietHoursExempt":true,"reason":"release week","by":"lead","at":"2030-01-08T10:00:00.000Z"}\n';
    const log = new LiftLog(new MemoryFiles({ [PATH]: formatTwo }), PATH);
    await log.append(lift({ session: 'bravo', group: true }));
    assert.deepEqual(await log.read(), { lifts: [lift(), lift({ session: 'bravo', group: true })], skipped: 0 });
  });

  it('starts a missing log, and refuses to write beside a newer teamrig', async () => {
    const empty = new LiftLog(new MemoryFiles(), PATH);
    assert.deepEqual(await empty.read(), { lifts: [], skipped: 0 });
    await empty.append(lift());
    assert.equal((await empty.read()).lifts.length, 1);
    const newer = new LiftLog(new MemoryFiles({ [PATH]: `{"v":${LIFT_FORMAT + 1},"session":"alpha"}\n` }), PATH);
    assert.deepEqual(await newer.read(), { lifts: [], skipped: 1 });
    await assert.rejects(newer.append(lift()), NewerDataError);
  });

  it('writes the pinned fields of its format: a field added to a lift raises LIFT_FORMAT', async () => {
    const written: Readonly<Record<number, readonly string[]>> = {
      2: ['at', 'by', 'endsAt', 'partPct', 'quietHoursExempt', 'reason', 'reserve', 'session', 'stopPct', 'v'],
      3: ['at', 'by', 'endsAt', 'group', 'partPct', 'quietHoursExempt', 'reason', 'reserve', 'session', 'stopPct', 'v'],
    };
    const files = new MemoryFiles();
    await new LiftLog(files, PATH).append(lift());
    assert.deepEqual(fieldPaths(JSON.parse(files.get(PATH) ?? '')), written[LIFT_FORMAT]);
  });
});
