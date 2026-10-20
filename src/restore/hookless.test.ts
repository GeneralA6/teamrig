import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_MINUTE } from '../core/time.ts';
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
  parseHooklessState,
  staleEntries,
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

const TAB: HooklessTab = { claudeSession: ALPHA, session: 'alpha', hookAt: NOW - 2 * HOOKLESS_MS, transcriptAt: NOW - MS_PER_MINUTE };

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
  it("keeps only a live, named session of the team with a transcript, whose hooks last wrote over HOOKLESS_MS ago", () => {
    const stale = entry();
    const kept = staleEntries(
      [
        stale,
        entry({ team: 'other' }),
        entry({ team: undefined }),
        entry({ session: undefined }),
        entry({ endedAt: NOW - HOOKLESS_MS }),
        entry({ transcriptPath: undefined }),
        entry({ updatedAt: NOW - HOOKLESS_MS }),
      ],
      'app',
      NOW,
    );
    assert.deepEqual(kept, [stale]);
  });
});

describe('hooklessTabs', () => {
  it('names a stale entry whose transcript changed lately, over HOOKLESS_MS past its last hook', () => {
    const stale = entry();
    assert.deepEqual(hooklessTabs([stale], new Map([[ALPHA, NOW - MS_PER_MINUTE]]), NOW), [TAB]);
  });

  it('skips a transcript that stopped (an idle tab), one that changed soon after the hook, or none at all', () => {
    const idle = entry();
    assert.deepEqual(hooklessTabs([idle], new Map([[ALPHA, NOW - HOOKLESS_MS - 1]]), NOW), []);
    const soon = entry({ updatedAt: NOW - HOOKLESS_MS - 10 * MS_PER_MINUTE });
    assert.deepEqual(hooklessTabs([soon], new Map([[ALPHA, NOW - 10 * MS_PER_MINUTE]]), NOW), []);
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

  it('names the session, its Claude session, the gap, both times and the fix', () => {
    const clock = (at: Date): string => `${at.toISOString().slice(11, 16)} UTC`;
    assert.equal(
      hooklessLine(TAB, clock),
      'HOOKLESS alpha: its tab (Claude session 0123abcd) worked 59 min past its last teamrig hook (hook 11:00 UTC, transcript 11:59 UTC), ' +
        'so it gets no inbox, guards or tab status: type /reload-plugins in that tab',
    );
  });
});
