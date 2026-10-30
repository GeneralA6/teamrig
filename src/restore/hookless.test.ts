import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_MINUTE } from '../core/time.ts';
import { TimeZone } from '../core/zone.ts';
import { promptLine, replyLine, systemLine } from '../testing/transcript-lines.ts';
import type { RestoreEntry } from './entry.ts';
import {
  checkedState,
  entrySession,
  formatHooklessState,
  HOOKLESS_CHECK_MS,
  HOOKLESS_MS,
  hooklessLine,
  hooklessNews,
  hooklessReader,
  hooklessTabs,
  isCheckDue,
  lastReplyAt,
  parseHooklessState,
  staleEntries,
  workedPastHook,
  type HooklessTab,
  type HooklessTeam,
  type StaleEntry,
} from './hookless.ts';

const NOW = Date.parse('2030-01-08T12:00:00Z');
const ALPHA = '0123abcd-0000-4000-8000-00000000000a';
const BRAVO = '0123abcd-0000-4000-8000-00000000000b';

function entry(overrides: Partial<RestoreEntry> = {}): RestoreEntry {
  return {
    claudeSession: ALPHA,
    projectDir: '/work/app',
    transcriptPath: '/u/.claude/projects/app/a.jsonl',
    entrypoint: 'cli',
    sessionKind: undefined,
    pid: 7000,
    team: 'app',
    session: 'alpha',
    state: 'working',
    createdAt: NOW - 5 * HOOKLESS_MS,
    updatedAt: NOW - 2 * HOOKLESS_MS,
    restoreAttempts: 0,
    restoredAt: undefined,
    endedAt: undefined,
    endReason: undefined,
    ...overrides,
  };
}

const TAB: HooklessTab = { claudeSession: ALPHA, session: 'alpha', projectDir: '/work/app', hookAt: NOW - 2 * HOOKLESS_MS, turnAt: NOW - MS_PER_MINUTE };
const RELOAD = '<command-name>/reload-plugins</command-name>\n<command-message>reload-plugins</command-message>\n<command-args></command-args>';

function iso(at: number): string {
  return new Date(at).toISOString();
}

/** A stale entry, the tab of session `session`. */
function stale(found: RestoreEntry = entry(), session = 'alpha'): StaleEntry {
  return { entry: found, session };
}

/** The alpha tab's transcript end, its last reply at `turnAt`. */
function replies(turnAt: number): ReadonlyMap<string, number> {
  return new Map([[ALPHA, turnAt]]);
}

describe('the hookless state file', () => {
  it('round-trips, and reads a damaged file or one of another format as no check yet', () => {
    const state = { checkedAt: NOW, told: [ALPHA] };
    assert.deepEqual(parseHooklessState(formatHooklessState(state)), state);
    for (const text of ['', 'not json', '{"v":2,"checkedAt":1,"told":[]}', '{"v":1,"checkedAt":"x","told":[]}', '{"v":1,"checkedAt":1,"told":[1]}']) {
      assert.equal(parseHooklessState(text), undefined, text);
    }
  });

  it('is due with no check yet, once HOOKLESS_CHECK_MS passed, or after the clock went back', () => {
    assert.equal(isCheckDue(undefined, NOW), true);
    assert.equal(isCheckDue({ checkedAt: NOW - HOOKLESS_CHECK_MS + 1, told: [] }, NOW), false);
    assert.equal(isCheckDue({ checkedAt: NOW - HOOKLESS_CHECK_MS, told: [] }, NOW), true);
    assert.equal(isCheckDue({ checkedAt: NOW + MS_PER_MINUTE, told: [] }, NOW), true);
  });
});

describe('entrySession and staleEntries', () => {
  const HAND = '0123abcd-0000-4000-8000-00000000000c';
  const RETIRED = '0123abcd-0000-4000-8000-00000000000d';
  const APP_TEAM: HooklessTeam = {
    team: 'app',
    sessions: ['lead', 'alpha'],
    areaBySession: new Map([
      [ALPHA, 'lead'],
      [HAND, 'alpha'],
      [RETIRED, 'retired'],
    ]),
  };
  const byHand = (claudeSession: string): RestoreEntry => entry({ claudeSession, team: undefined, session: undefined });

  it("takes a launched tab's session from its variables, and a tab started by hand's from the inbox it last read (T1002)", () => {
    assert.equal(entrySession(entry(), APP_TEAM), 'alpha', "the variables win over the marks' lead");
    assert.equal(entrySession(byHand(HAND), APP_TEAM), 'alpha');
  });

  it("leaves out another team's tab, a session the team no longer has, and a tab started by hand that read no inbox", () => {
    assert.equal(entrySession(entry({ claudeSession: HAND, team: 'other' }), APP_TEAM), undefined, 'variables naming another team');
    assert.equal(entrySession(entry({ session: 'retired' }), APP_TEAM), undefined);
    assert.equal(entrySession(entry({ session: undefined }), APP_TEAM), undefined, 'variables naming the team and no session');
    assert.equal(entrySession(byHand(RETIRED), APP_TEAM), undefined);
    assert.equal(entrySession(byHand(BRAVO), APP_TEAM), undefined);
  });

  it('keeps only a live tab of a team session with a transcript, whose hooks last wrote over HOOKLESS_MS ago', () => {
    const stale = entry();
    const hand = byHand(HAND);
    const kept = staleEntries(
      [
        stale,
        hand,
        entry({ team: 'other' }),
        entry({ endedAt: NOW - HOOKLESS_MS }),
        entry({ transcriptPath: undefined }),
        entry({ updatedAt: NOW - HOOKLESS_MS }),
      ],
      APP_TEAM,
      NOW,
    );
    assert.deepEqual(kept, [
      { entry: stale, session: 'alpha' },
      { entry: hand, session: 'alpha' },
    ]);
  });
});

describe('workedPastHook', () => {
  it('holds for a time within the last HOOKLESS_MS and over HOOKLESS_MS past the hook', () => {
    const hookAt = NOW - 3 * HOOKLESS_MS;
    assert.equal(workedPastHook(hookAt, NOW - HOOKLESS_MS, NOW), true);
    assert.equal(workedPastHook(hookAt, NOW - HOOKLESS_MS - 1, NOW), false, 'stopped over HOOKLESS_MS ago');
    assert.equal(workedPastHook(NOW - HOOKLESS_MS - MS_PER_MINUTE - 1, NOW - MS_PER_MINUTE, NOW), true, 'just over HOOKLESS_MS after the hook');
    assert.equal(workedPastHook(NOW - HOOKLESS_MS - MS_PER_MINUTE, NOW - MS_PER_MINUTE, NOW), false, 'HOOKLESS_MS after the hook, no more');
  });
});

describe('lastReplyAt', () => {
  it("reads the main thread's last reply, whichever lines come after it", () => {
    const lines = [
      replyLine({ at: iso(NOW - 40 * MS_PER_MINUTE), usage: { output: 1 } }),
      promptLine(iso(NOW - 30 * MS_PER_MINUTE), RELOAD),
      replyLine({ at: iso(NOW - 20 * MS_PER_MINUTE), usage: { output: 1 } }),
      promptLine(iso(NOW - 10 * MS_PER_MINUTE), RELOAD),
      systemLine(iso(NOW - 5 * MS_PER_MINUTE)),
    ];
    assert.equal(lastReplyAt(lines), NOW - 20 * MS_PER_MINUTE);
  });

  it("leaves out a helper's reply, prompts, a reload, undated and damaged lines", () => {
    const lines = [
      replyLine({ at: iso(NOW - MS_PER_MINUTE), sidechain: true, usage: { output: 1 } }),
      replyLine({ usage: { output: 1 } }),
      replyLine({ at: iso(NOW - MS_PER_MINUTE), usage: { output: 1 } }).slice(20),
      promptLine(iso(NOW - MS_PER_MINUTE), 'go on with T1055'),
      promptLine(iso(NOW - MS_PER_MINUTE), RELOAD),
      systemLine(iso(NOW)),
    ];
    assert.equal(lastReplyAt(lines), undefined);
  });
});

describe('hooklessTabs', () => {
  it('names a stale entry whose last reply came lately, over HOOKLESS_MS past its last hook, as the session it runs as', () => {
    assert.deepEqual(hooklessTabs([stale()], replies(NOW - MS_PER_MINUTE), NOW), [TAB]);
    const byHand = stale(entry({ team: undefined, session: undefined }), 'bravo');
    assert.deepEqual(hooklessTabs([byHand], replies(NOW - MS_PER_MINUTE), NOW), [{ ...TAB, session: 'bravo' }]);
  });

  it('skips a tab with no reply lately (an idle tab whose transcript moves with no turn), one soon after the hook, or none read', () => {
    assert.deepEqual(hooklessTabs([stale()], replies(NOW - HOOKLESS_MS - 1), NOW), []);
    const soon = stale(entry({ updatedAt: NOW - HOOKLESS_MS - 10 * MS_PER_MINUTE }));
    assert.deepEqual(hooklessTabs([soon], replies(NOW - 10 * MS_PER_MINUTE), NOW), []);
    assert.deepEqual(hooklessTabs([stale()], new Map(), NOW), []);
  });
});

describe('hooklessNews and checkedState', () => {
  it('names a tab once while it stays hookless, and again after it had its hooks back', () => {
    const first = hooklessNews(undefined, [TAB]);
    assert.deepEqual(first, [TAB]);
    const told = checkedState(NOW, [TAB]);
    assert.deepEqual(told, { checkedAt: NOW, told: [ALPHA] });
    assert.deepEqual(hooklessNews(told, [TAB]), []);
    const recovered = checkedState(NOW + HOOKLESS_CHECK_MS, []);
    assert.deepEqual(hooklessNews(recovered, [TAB]), [TAB]);
    const bravo: HooklessTab = { ...TAB, claudeSession: BRAVO, session: 'bravo' };
    assert.deepEqual(hooklessNews(told, [TAB, bravo]), [bravo]);
  });
});

describe('hooklessReader and hooklessLine', () => {
  it("tells the lead, or the delivery owner of the lead's own tab, one on a team above too (T1143)", () => {
    const roles = { lead: 'lead', deliveryOwner: 'po' };
    assert.deepEqual(hooklessReader(TAB, roles, 'app'), { team: 'app', id: 'lead' });
    const lead: HooklessTab = { ...TAB, session: 'lead' };
    assert.deepEqual(hooklessReader(lead, roles, 'app'), { team: 'app', id: 'po' });
    assert.deepEqual(hooklessReader(lead, { lead: 'lead' }, 'app'), { team: 'app', id: 'lead' });
    assert.deepEqual(hooklessReader(lead, { lead: 'lead', deliveryOwner: 'root/po' }, 'app'), { team: 'root', id: 'po' });
  });

  it('names the session, its Claude session, the gap, both times and a restart in its folder, never a reload', () => {
    assert.equal(
      hooklessLine(TAB, 'alpha', TimeZone.UTC, NOW),
      'HOOKLESS alpha: its tab (Claude session 0123abcd) worked 59 min past its last teamrig hook (hook 11:00 UTC, last reply 11:59 UTC), ' +
        `so it gets no inbox, guards or tab status: /exit that tab and run claude --resume ${ALPHA} in /work/app`,
    );
    assert.match(hooklessLine(TAB, 'app/alpha', TimeZone.UTC, NOW), /^HOOKLESS app\/alpha: its tab /, "a team above's reader reads the session's address");
  });

  it("dates a time off the line's day on the zone's calendar, so days do not read as hours (T1069)", () => {
    const daysAgo = { ...TAB, hookAt: NOW - 3 * 24 * 60 * MS_PER_MINUTE - 23 * MS_PER_MINUTE };
    assert.match(hooklessLine(daysAgo, 'alpha', TimeZone.UTC, NOW), /worked 4342 min past its last teamrig hook \(hook 01-05 11:37 UTC, last reply 11:59 UTC\)/);
    const zone = TimeZone.of('Asia/Jerusalem');
    assert.ok(zone !== undefined);
    const pastMidnight = NOW + 630 * MS_PER_MINUTE;
    assert.match(
      hooklessLine({ ...TAB, turnAt: pastMidnight - 10 * MS_PER_MINUTE }, 'alpha', zone, pastMidnight),
      /\(hook 01-08 13:00 IST, last reply 00:20 IST\)/,
      "the zone's midnight, not UTC's, starts the line's day",
    );
  });
});
