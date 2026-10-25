import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Roster } from '../config/roster.ts';
import { TimeZone } from '../core/zone.ts';
import type { SessionLogRecord } from '../sessions/log.ts';
import type { SessionRecord } from '../sessions/record.ts';
import { FIRST_HOOK_MS, hooklessReopenLine, hooklessReopensOf } from './hookless-reopen.ts';

const ROSTER = new Roster({ sessions: ['lead', 'alpha', 'bravo'], names: { alpha: 'api' }, roles: { lead: 'lead' } }, 'app');
const CLOSED_AT = '2030-01-08T09:00:00.000Z';
const REOPENED_AT = '2030-01-08T10:00:00.000Z';
const REOPEN = Date.parse(REOPENED_AT);
const CLOSE_ALPHA: SessionLogRecord = { kind: 'close', session: 'alpha', by: 'idle-pass', at: CLOSED_AT, claudeSession: 'c-alpha', idleMinutes: 75, freedMb: 1300 };
const REOPEN_ALPHA: SessionLogRecord = { kind: 'reopen', session: 'alpha', at: REOPENED_AT, resumed: 'c-alpha' };
const LOG: readonly SessionLogRecord[] = [CLOSE_ALPHA, REOPEN_ALPHA];

function started(at: string): SessionRecord {
  return { claudePid: 8100, claudeSession: 'c-alpha', at };
}

function startsOf(alpha: SessionRecord | undefined): Map<string, SessionRecord | undefined> {
  return new Map([['alpha', alpha]]);
}

describe('hooklessReopensOf', () => {
  it('names a reopen FIRST_HOOK_MS old whose start record is missing or from before its close', () => {
    const hookless = [{ id: 'alpha', at: REOPEN, resumed: 'c-alpha' }];
    assert.deepEqual(hooklessReopensOf(LOG, startsOf(undefined), ROSTER.ids, REOPEN + FIRST_HOOK_MS), hookless);
    assert.deepEqual(hooklessReopensOf(LOG, startsOf(started('2030-01-08T08:00:00.000Z')), ROSTER.ids, REOPEN + FIRST_HOOK_MS), hookless);
    assert.deepEqual(hooklessReopensOf(LOG, startsOf(started(CLOSED_AT)), ROSTER.ids, REOPEN + FIRST_HOOK_MS), hookless, 'no newer than the close');
  });

  it('names none under FIRST_HOOK_MS, or with the clock gone back', () => {
    assert.deepEqual(hooklessReopensOf(LOG, startsOf(undefined), ROSTER.ids, REOPEN + FIRST_HOOK_MS - 1), []);
    assert.deepEqual(hooklessReopensOf(LOG, startsOf(undefined), ROSTER.ids, REOPEN - 1), []);
  });

  it('names none whose tab started a hook after the close, one before the reopen was logged too', () => {
    assert.deepEqual(hooklessReopensOf(LOG, startsOf(started('2030-01-08T09:59:58.000Z')), ROSTER.ids, REOPEN + FIRST_HOOK_MS), []);
    assert.deepEqual(hooklessReopensOf(LOG, startsOf(started('2030-01-08T10:01:00.000Z')), ROSTER.ids, REOPEN + FIRST_HOOK_MS), []);
  });

  it('names none whose newest record is a close, nor one never closed or off the roster', () => {
    const closedAgain: SessionLogRecord = { ...CLOSE_ALPHA, at: '2030-01-08T10:30:00.000Z' };
    const now = REOPEN + 60 * 60_000;
    assert.deepEqual(hooklessReopensOf([...LOG, closedAgain], startsOf(undefined), ROSTER.ids, now), []);
    assert.deepEqual(hooklessReopensOf([], startsOf(undefined), ROSTER.ids, now), []);
    assert.deepEqual(hooklessReopensOf(LOG, startsOf(undefined), ['lead', 'bravo'], now), []);
  });

  it("measures from the reopen's own time when no close comes before it", () => {
    const now = REOPEN + FIRST_HOOK_MS;
    assert.deepEqual(hooklessReopensOf([REOPEN_ALPHA], startsOf(started('2030-01-08T09:30:00.000Z')), ROSTER.ids, now), [{ id: 'alpha', at: REOPEN, resumed: 'c-alpha' }]);
    assert.deepEqual(hooklessReopensOf([REOPEN_ALPHA], startsOf(started('2030-01-08T10:00:01.000Z')), ROSTER.ids, now), []);
  });
});

describe('hooklessReopenLine', () => {
  it('asks a resumed tab to resume again in its terminal, and a fresh one to open again', () => {
    const now = REOPEN + 7 * 60_000 + 59_000;
    assert.equal(
      hooklessReopenLine({ id: 'alpha', at: REOPEN, resumed: 'c-alpha' }, 'alpha', ROSTER, TimeZone.UTC, now),
      'HOOKLESS api (session alpha): reopened 01-08 10:00 UTC, and no teamrig hook has started in its tab in the 7 min since, so it gets no inbox, guards or tab status: /exit that tab and run claude --resume c-alpha in its terminal',
    );
    assert.match(hooklessReopenLine({ id: 'bravo', at: REOPEN, resumed: undefined }, 'bravo', ROSTER, TimeZone.UTC, now), /^HOOKLESS app-bravo \(session bravo\): .*: \/exit that tab and run teamrig open bravo$/);
  });

  it("names the session by its address for a reader on a team above, which open takes there too (T1143)", () => {
    const now = REOPEN + 6 * 60_000;
    assert.match(
      hooklessReopenLine({ id: 'lead', at: REOPEN, resumed: undefined }, 'app/lead', ROSTER, TimeZone.UTC, now),
      /^HOOKLESS app-lead \(session app\/lead\): .*: \/exit that tab and run teamrig open app\/lead$/,
    );
  });
});
