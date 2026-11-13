import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { wakeCost } from '../wake/decide.ts';
import { WAKE_AT_ONCE, wakeByOf, wakeRefusal, wakesLine, type ReceiverWake, type WakeSender, type WakeWhen } from './wake-now.ts';

const MINUTE = 60_000;
const NOW = Date.parse('2030-01-08T10:00:00Z');
const BY: WakeWhen = { kind: 'by', at: Date.parse('2030-01-08T16:30:00Z'), clock: '18:30 IST' };
/** A week of 1M W per percent: a warm wake (27k W) is 0.027% of it, a cold one (210k W) 0.21%. */
const W_PER_PCT = 1_000_000;

const MEMBER: WakeSender = { team: 'app', id: 'alpha', leader: false, teamLead: false, below: ['web', 'ui', 'ops'] };
const SUB_LEAD: WakeSender = { ...MEMBER, id: 'bravo', leader: true };
const APP_LEAD: WakeSender = { ...MEMBER, id: 'lead', leader: true, teamLead: true };
const WEB_LEAD: WakeSender = { team: 'web', id: 'lead', leader: true, teamLead: true, below: ['ui'] };

function warm(label: string, team: string, wPerPct?: number): ReceiverWake {
  return { label, team, batchSeconds: 120, cost: wakeCost(5 * MINUTE, 60, wPerPct, undefined) };
}

function cold(label: string, team: string, wPerPct?: number): ReceiverWake {
  return { label, team, batchSeconds: 120, cost: wakeCost(undefined, 60, wPerPct, undefined) };
}

describe('wakeRefusal', () => {
  it('lets any session wake sessions of its own team it names one by one', () => {
    assert.equal(wakeRefusal(MEMBER, false, [{ label: 'bravo', team: 'app' }, { label: 'lead', team: 'app' }], WAKE_AT_ONCE), undefined);
  });

  it('refuses a group from a session that leads no one, and lets a leader wake one', () => {
    assert.equal(
      wakeRefusal(MEMBER, true, [{ label: 'bravo', team: 'app' }], WAKE_AT_ONCE),
      "--wake now on a group is a leader's: alpha leads no one on app; post the line without --wake, and each receiver reads it at its next prompt",
    );
    assert.equal(wakeRefusal(SUB_LEAD, true, [{ label: 'charlie', team: 'app' }], WAKE_AT_ONCE), undefined);
  });

  it('lets the lead of a team above wake sessions of the teams below it, at any depth', () => {
    assert.equal(wakeRefusal(APP_LEAD, false, [{ label: 'web/front', team: 'web' }, { label: 'ui/pixel', team: 'ui' }], WAKE_AT_ONCE), undefined);
    assert.equal(wakeRefusal(APP_LEAD, true, [{ label: 'web/lead', team: 'web' }, { label: 'ops/lead', team: 'ops' }], WAKE_AT_ONCE), undefined);
  });

  it('refuses another team to a member or a sub-lead, and a team above or beside to a lead, naming each refused receiver', () => {
    const outside = (sender: string, labels: string): string =>
      `--wake now reaches another team only from the lead of a team above it, since a wake spends that team's budget line: ${sender} may not wake ${labels}; post the line without --wake`;
    assert.equal(wakeRefusal(MEMBER, false, [{ label: 'bravo', team: 'app' }, { label: 'web/front', team: 'web' }], WAKE_AT_ONCE), outside('app/alpha', 'web/front'));
    assert.equal(wakeRefusal(SUB_LEAD, false, [{ label: 'web/front', team: 'web' }], WAKE_AT_ONCE), outside('app/bravo', 'web/front'));
    assert.equal(
      wakeRefusal(WEB_LEAD, false, [{ label: 'app/lead', team: 'app' }, { label: 'ui/pixel', team: 'ui' }, { label: 'ops/run', team: 'ops' }], WAKE_AT_ONCE),
      outside('web/lead', 'app/lead, ops/run'),
    );
  });

  it('names --wake-by in its refusals when that flag asked the wake', () => {
    assert.equal(
      wakeRefusal(MEMBER, true, [{ label: 'bravo', team: 'app' }], BY),
      "--wake-by on a group is a leader's: alpha leads no one on app; post the line without --wake-by, and each receiver reads it at its next prompt",
    );
    assert.equal(
      wakeRefusal(SUB_LEAD, false, [{ label: 'web/front', team: 'web' }], BY),
      "--wake-by reaches another team only from the lead of a team above it, since a wake spends that team's budget line: app/bravo may not wake web/front; post the line without --wake-by",
    );
  });
});

describe('wakeByOf', () => {
  it("shows the time on the team's clock, with its date when that is not today there", () => {
    const evening = Date.parse('2030-01-08T16:30:00Z');
    const late = Date.parse('2030-01-08T22:30:00Z');
    assert.deepEqual(wakeByOf(evening, NOW, JERUSALEM), { kind: 'by', at: evening, clock: '18:30 IST' });
    assert.deepEqual(wakeByOf(late, NOW, JERUSALEM), { kind: 'by', at: late, clock: '01-09 00:30 IST' }, 'tomorrow in Jerusalem');
    assert.deepEqual(wakeByOf(late, NOW, TimeZone.UTC), { kind: 'by', at: late, clock: '22:30 UTC' }, 'still today in UTC');
  });
});

describe('wakesLine', () => {
  it('names one receiver, its cost and the budget line of its team', () => {
    assert.equal(wakesLine([warm('bravo', 'app')], [], WAKE_AT_ONCE), "WAKES bravo if its tab is idle, within about 3 minutes: at least about 27k W for the first call, warm cache; whole turns usually cost more, on app's budget line");
    assert.equal(
      wakesLine([cold('web/front', 'web', W_PER_PCT)], [], WAKE_AT_ONCE),
      "WAKES web/front if its tab is idle, within about 3 minutes: at least about 210k W for the first call, cold, 0.21% of the week; whole turns usually cost more, on web's budget line",
    );
  });

  it('sums many receivers, warm and cold, and names each team paying once', () => {
    assert.equal(
      wakesLine([warm('bravo', 'app'), cold('web/front', 'web'), cold('web/back', 'web')], [], WAKE_AT_ONCE),
      'WAKES at most 3 sessions, those whose tab is idle, within about 3 minutes: about 447k W (1 warm cache, 2 cold), on the budget lines of app, web',
    );
    assert.equal(
      wakesLine([warm('bravo', 'app', W_PER_PCT), warm('charlie', 'app', W_PER_PCT)], [], WAKE_AT_ONCE),
      "WAKES at most 2 sessions, those whose tab is idle, within about 3 minutes: about 54k W (2 warm cache), 0.05% of the week, on app's budget line",
    );
  });

  it('gives the share of the week only when every wake has one, and under 0.01% for less', () => {
    assert.equal(
      wakesLine([warm('bravo', 'app', W_PER_PCT), cold('charlie', 'app')], [], WAKE_AT_ONCE),
      "WAKES at most 2 sessions, those whose tab is idle, within about 3 minutes: about 237k W (1 warm cache, 1 cold), on app's budget line",
    );
    assert.equal(
      wakesLine([warm('bravo', 'app', 1_000_000_000)], [], WAKE_AT_ONCE),
      "WAKES bravo if its tab is idle, within about 3 minutes: at least about 27k W for the first call, warm cache, under 0.01% of the week; whole turns usually cost more, on app's budget line",
    );
  });

  it("says when the wake comes: the slowest team's wake.batchSeconds and a wake-hand tick, at least a minute", () => {
    const at = (batchSeconds: number): ReceiverWake => ({ ...warm('bravo', 'app'), batchSeconds });
    assert.equal(wakesLine([at(0)], [], WAKE_AT_ONCE), "WAKES bravo if its tab is idle, within about 1 minute: at least about 27k W for the first call, warm cache; whole turns usually cost more, on app's budget line");
    assert.equal(
      wakesLine([at(0), { ...cold('web/front', 'web'), batchSeconds: 600 }], [], WAKE_AT_ONCE),
      'WAKES at most 2 sessions, those whose tab is idle, within about 11 minutes: about 237k W (1 warm cache, 1 cold), on the budget lines of app, web',
    );
  });

  it('names the receivers whose team turned wakes off, and wakes no one when that is all of them', () => {
    assert.equal(
      wakesLine([warm('bravo', 'app')], ['web/front'], WAKE_AT_ONCE),
      "WAKES bravo if its tab is idle, within about 3 minutes: at least about 27k W for the first call, warm cache; whole turns usually cost more, on app's budget line; wake.enabled is false on the team of web/front, so its line wakes no one",
    );
    assert.equal(
      wakesLine([warm('bravo', 'app'), warm('charlie', 'app')], ['web/front', 'web/back'], WAKE_AT_ONCE),
      "WAKES at most 2 sessions, those whose tab is idle, within about 3 minutes: about 54k W (2 warm cache), on app's budget line; wake.enabled is false on the team of web/front, web/back, so their lines wake no one",
    );
    assert.equal(wakesLine([], ['web/front', 'web/back'], WAKE_AT_ONCE), 'WAKES no one: wake.enabled is false on the team of web/front, web/back');
  });

  it('says a --wake-by wake comes at its time, and only to a receiver that has not seen the line by then', () => {
    assert.equal(
      wakesLine([warm('bravo', 'app')], [], BY),
      "WAKES bravo at 18:30 IST if it has not seen the line by then and its tab is idle: at least about 27k W for the first call, warm cache; whole turns usually cost more, on app's budget line",
    );
    assert.equal(
      wakesLine([warm('bravo', 'app'), cold('web/front', 'web')], ['ops/run'], BY),
      'WAKES at most 2 sessions at 18:30 IST, those that have not seen the line by then and whose tab is idle: about 237k W (1 warm cache, 1 cold), ' +
        'on the budget lines of app, web; wake.enabled is false on the team of ops/run, so its line wakes no one',
    );
  });
});
