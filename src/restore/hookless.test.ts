import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_MINUTE } from '../core/time.ts';
import { promptLine, replyLine, systemLine } from '../testing/transcript-lines.ts';
import type { RestoreEntry } from './entry.ts';
import {
  checkedState,
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

describe('staleEntries', () => {
  it("keeps only a live session on the team with a transcript, whose hooks last wrote over HOOKLESS_MS ago", () => {
    const stale = entry();
    const kept = staleEntries(
      [
        stale,
        entry({ team: 'other' }),
        entry({ team: undefined }),
        entry({ session: undefined }),
        entry({ session: 'retired' }),
        entry({ endedAt: NOW - HOOKLESS_MS }),
        entry({ transcriptPath: undefined }),
        entry({ updatedAt: NOW - HOOKLESS_MS }),
      ],
      'app',
      ['lead', 'alpha'],
      NOW,
    );
    assert.deepEqual(kept, [stale]);
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
  it('names a stale entry whose last reply came lately, over HOOKLESS_MS past its last hook', () => {
    assert.deepEqual(hooklessTabs([entry()], replies(NOW - MS_PER_MINUTE), NOW), [TAB]);
  });

  it('skips a tab with no reply lately (an idle tab whose transcript moves with no turn), one soon after the hook, or none read', () => {
    assert.deepEqual(hooklessTabs([entry()], replies(NOW - HOOKLESS_MS - 1), NOW), []);
    const soon = entry({ updatedAt: NOW - HOOKLESS_MS - 10 * MS_PER_MINUTE });
    assert.deepEqual(hooklessTabs([soon], replies(NOW - 10 * MS_PER_MINUTE), NOW), []);
    assert.deepEqual(hooklessTabs([entry()], new Map(), NOW), []);
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
  it("tells the lead, or the coordinator's owner of the lead's own tab", () => {
    assert.equal(hooklessReader(TAB, 'lead', 'po'), 'lead');
    const lead: HooklessTab = { ...TAB, session: 'lead' };
    assert.equal(hooklessReader(lead, 'lead', 'po'), 'po');
    assert.equal(hooklessReader(lead, 'lead', undefined), 'lead');
  });

  it('names the session, its Claude session, the gap, both times and a restart in its folder, never a reload', () => {
    const clock = (at: Date): string => `${at.toISOString().slice(11, 16)} UTC`;
    assert.equal(
      hooklessLine(TAB, clock),
      'HOOKLESS alpha: its tab (Claude session 0123abcd) worked 59 min past its last teamrig hook (hook 11:00 UTC, last reply 11:59 UTC), ' +
        `so it gets no inbox, guards or tab status: /exit that tab and run claude --resume ${ALPHA} in /work/app`,
    );
  });
});
