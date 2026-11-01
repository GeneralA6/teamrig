import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, parse, resolve } from 'node:path';
import { PROMPT_MAX } from '../open/prompt.ts';
import { FakePathProbe } from '../testing/fake-processes.ts';
import type { RestoreEntry } from './entry.ts';
import {
  chooseMode,
  CLOSED_KEEP_MS,
  CONTINUE_PROMPT,
  continuePrompt,
  describeLostWork,
  diedAt,
  judgeEntry,
  lastRecordedEffort,
  lostWorkOf,
  MAX_ENTRY_AGE_MS,
  nearestExistingFolder,
  RESTORE_IN_FLIGHT_MS,
  selectRestorePlan,
  SHUTDOWN_GRACE_MS,
  summarizeRestore,
  type JudgeFacts,
  type LostWork,
} from './plan.ts';

const SESSION = '11111111-2222-4333-8444-555555555555';
const LOGON = Date.parse('2030-01-08T08:00:00Z');
const SHUTDOWN = LOGON - 5 * 60_000;
const NOW = LOGON + 60_000;
const NOTHING: LostWork = { background: 0, crons: 0, wake: false };

function entry(overrides: Partial<RestoreEntry> = {}): RestoreEntry {
  return {
    claudeSession: SESSION,
    projectDir: '/work/app',
    transcriptPath: '/claude/projects/app/s.jsonl',
    entrypoint: 'cli',
    sessionKind: undefined,
    pid: 4242,
    team: undefined,
    session: undefined,
    state: 'ready',
    createdAt: SHUTDOWN - 3_600_000,
    updatedAt: SHUTDOWN - 60_000,
    restoreAttempts: 0,
    restoredAt: undefined,
    endedAt: undefined,
    endReason: undefined,
    ...overrides,
  };
}

function facts(overrides: Partial<JudgeFacts> = {}): JudgeFacts {
  return {
    now: NOW,
    since: LOGON,
    shutdown: { start: SHUTDOWN, end: SHUTDOWN + 60_000 },
    running: new Set(),
    transcripts: new Map([[SESSION, '/claude/projects/app/s.jsonl']]),
    kinds: new Map(),
    ...overrides,
  };
}

describe('judgeEntry', () => {
  it('restores a session killed without exiting, and one the shutdown closed', () => {
    assert.deepEqual(judgeEntry(entry(), facts()), { verdict: 'restore', reason: 'killed without exiting' });
    const closed = entry({ endedAt: SHUTDOWN - SHUTDOWN_GRACE_MS, endReason: 'other' });
    assert.deepEqual(judgeEntry(closed, facts()), { verdict: 'restore', reason: 'closed by the shutdown' });
  });

  it('keeps a tab closed outside the shutdown, before or after it, or with no clean shutdown on record, as closed', () => {
    const early = entry({ endedAt: SHUTDOWN - SHUTDOWN_GRACE_MS - 1, endReason: 'other' });
    assert.deepEqual(judgeEntry(early, facts()), { verdict: 'closed', reason: 'closed outside a shutdown' });
    const late = entry({ endedAt: SHUTDOWN + 60_001, updatedAt: SHUTDOWN + 60_001, endReason: 'other' });
    assert.deepEqual(judgeEntry(late, facts()), { verdict: 'closed', reason: 'closed outside a shutdown' });
    const last = entry({ endedAt: SHUTDOWN + 60_000, updatedAt: SHUTDOWN + 60_000, endReason: 'other' });
    assert.deepEqual(judgeEntry(last, facts()), { verdict: 'restore', reason: 'closed by the shutdown' });
    const closed = entry({ endedAt: SHUTDOWN, endReason: 'other' });
    assert.deepEqual(judgeEntry(closed, facts({ shutdown: undefined })), { verdict: 'closed', reason: 'closed, no shutdown on record' });
  });

  it('restores a tab closed outside a shutdown mid-turn or on an API error', () => {
    const working = entry({ endedAt: SHUTDOWN - 3_600_000, endReason: 'other', state: 'working' });
    assert.deepEqual(judgeEntry(working, facts()), { verdict: 'restore', reason: 'closed mid-turn' });
    const failed = entry({ endedAt: SHUTDOWN - 3_600_000, endReason: 'other', state: 'error' });
    assert.deepEqual(judgeEntry(failed, facts({ shutdown: undefined })), { verdict: 'restore', reason: 'closed on an API error' });
  });

  it('discards a tab closed outside a shutdown more than CLOSED_KEEP_MS ago, mid-turn too', () => {
    const old = NOW - CLOSED_KEEP_MS - 1;
    assert.deepEqual(judgeEntry(entry({ endedAt: old, updatedAt: old, endReason: 'other' }), facts()), {
      verdict: 'discard',
      reason: 'closed more than 48 h ago',
    });
    assert.equal(judgeEntry(entry({ endedAt: old, updatedAt: old, endReason: 'other', state: 'working' }), facts()).verdict, 'discard');
    const edge = NOW - CLOSED_KEEP_MS;
    assert.equal(judgeEntry(entry({ endedAt: edge, updatedAt: edge, endReason: 'other' }), facts()).verdict, 'closed');
  });

  it('replays 11-01: tabs that ended minutes before an update restart are restored on an API error, else kept as closed', () => {
    const ended = LOGON - 10 * 60_000;
    const restart = facts({ now: LOGON, since: LOGON, shutdown: { start: ended + 7 * 60_000, end: ended + 8 * 60_000 } });
    const failed = entry({ endedAt: ended, updatedAt: ended, endReason: 'other', state: 'error' });
    assert.deepEqual(judgeEntry(failed, restart), { verdict: 'restore', reason: 'closed on an API error' });
    const idle = entry({ endedAt: ended, updatedAt: ended, endReason: 'other' });
    assert.deepEqual(judgeEntry(idle, restart), { verdict: 'closed', reason: 'closed outside a shutdown' });
  });

  it('judges a tab closed outside a shutdown the same whether that shutdown came after it or a day before it (T1737)', () => {
    const ended = SHUTDOWN - 3_600_000;
    const dayBefore = facts({ shutdown: { start: SHUTDOWN - 86_400_000, end: SHUTDOWN - 86_400_000 + 60_000 } });
    for (const state of ['ready', 'working', 'error'] as const) {
      const closed = entry({ endedAt: ended, updatedAt: ended, endReason: 'other', state });
      assert.deepEqual(judgeEntry(closed, dayBefore), judgeEntry(closed, facts()), state);
    }
    assert.equal(judgeEntry(entry({ endedAt: ended, updatedAt: ended, endReason: 'other' }), dayBefore).verdict, 'closed');
  });

  it('discards an end the person chose', () => {
    assert.deepEqual(judgeEntry(entry({ endedAt: SHUTDOWN, endReason: 'prompt_input_exit' }), facts()), {
      verdict: 'discard',
      reason: 'exited (prompt_input_exit)',
    });
  });

  it('discards what is no terminal tab: another entrypoint, a background session', () => {
    assert.equal(judgeEntry(entry({ entrypoint: 'sdk-ts' }), facts()).reason, 'not a terminal session (sdk-ts)');
    assert.equal(judgeEntry(entry({ sessionKind: 'bg' }), facts()).reason, 'background session');
    assert.equal(judgeEntry(entry({ entrypoint: undefined }), facts()).verdict, 'restore');
  });

  it('discards a session its transcript shows as a background job or continued in another, though no end was recorded', () => {
    const job = '9ac07f9d-2832-4320-88f9-69e667e4c38e';
    const background = facts({ kinds: new Map([[SESSION, { background: true, continuedIn: undefined }]]) });
    assert.deepEqual(judgeEntry(entry(), background), { verdict: 'discard', reason: 'background session' });
    const moved = facts({ kinds: new Map([[SESSION, { background: false, continuedIn: job }]]) });
    assert.deepEqual(judgeEntry(entry(), moved), { verdict: 'discard', reason: 'continued in 9ac07f9d' });
    const tab = facts({ kinds: new Map([[SESSION, { background: false, continuedIn: undefined }]]) });
    assert.deepEqual(judgeEntry(entry(), tab), { verdict: 'restore', reason: 'killed without exiting' });
    assert.equal(judgeEntry(entry(), { ...moved, running: new Set([SESSION]) }).verdict, 'keep');
  });

  it('keeps a session reopened moments ago that has not started, and gives one up after repeated failures', () => {
    const reopened = entry({ restoredAt: NOW - 60_000, restoreAttempts: 2 });
    assert.deepEqual(judgeEntry(reopened, facts()), { verdict: 'keep', reason: 'reopened, not started yet' });
    const late = entry({ restoredAt: NOW - RESTORE_IN_FLIGHT_MS, restoreAttempts: 2 });
    assert.deepEqual(judgeEntry(late, facts()), { verdict: 'discard', reason: 'restore failed repeatedly' });
    assert.equal(judgeEntry(entry({ restoredAt: NOW - RESTORE_IN_FLIGHT_MS, restoreAttempts: 1 }), facts()).verdict, 'restore');
  });

  it('discards a stale entry and keeps one active since logon or still running', () => {
    assert.equal(judgeEntry(entry({ updatedAt: NOW - MAX_ENTRY_AGE_MS - 1 }), facts()).reason, 'stale');
    assert.equal(judgeEntry(entry({ updatedAt: LOGON }), facts()).reason, 'active since logon');
    assert.equal(judgeEntry(entry(), facts({ running: new Set([SESSION]) })).reason, 'still running');
  });

  it('discards a session with no transcript left to resume', () => {
    assert.deepEqual(judgeEntry(entry(), facts({ transcripts: new Map() })), { verdict: 'discard', reason: 'no transcript' });
  });
});

describe('selectRestorePlan', () => {
  it('sorts each verdict oldest session first', () => {
    const other = '99999999-2222-4333-8444-555555555555';
    const shut = 'bbbbbbbb-2222-4333-8444-555555555555';
    const older = entry({ claudeSession: other, createdAt: SHUTDOWN - 7_200_000 });
    const closed = entry({ claudeSession: shut, endedAt: SHUTDOWN - 3_600_000, endReason: 'other' });
    const plan = selectRestorePlan([entry(), older, closed, entry({ claudeSession: 'aaaaaaaa-2222-4333-8444-555555555555' })], facts({
      transcripts: new Map([
        [SESSION, 't1'],
        [other, 't2'],
        [shut, 't3'],
      ]),
    }));
    assert.deepEqual(plan.restore.map((judged) => judged.entry.claudeSession), [other, SESSION]);
    assert.deepEqual(plan.closed.map((judged) => judged.entry.claudeSession), [shut]);
    assert.deepEqual(plan.discard.map((judged) => judged.reason), ['no transcript']);
    assert.deepEqual(plan.keep, []);
  });
});

describe('diedAt', () => {
  it('takes the end, else the shutdown, else the last event', () => {
    assert.equal(diedAt(entry({ endedAt: SHUTDOWN + 1 }), SHUTDOWN), SHUTDOWN + 1);
    assert.equal(diedAt(entry(), SHUTDOWN), SHUTDOWN);
    assert.equal(diedAt(entry(), undefined), SHUTDOWN - 60_000);
  });
});

/** Transcript lines in Claude Code's shape: a tool call and its result. */
function call(id: string, name: string, input: object, at: number): string {
  return JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
}

function result(id: string, toolUseResult: object, at: number): string {
  return JSON.stringify({
    type: 'user',
    timestamp: new Date(at).toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    toolUseResult,
  });
}

describe('lostWorkOf', () => {
  it('counts the background work, cron jobs and wake-up live when the session died', () => {
    const at = SHUTDOWN - 10 * 60_000;
    const text = [
      call('toolu_bash', 'Bash', { command: 'npm test', run_in_background: true }, at),
      result('toolu_bash', { stdout: '', backgroundTaskId: 'b1' }, at),
      call('toolu_cron', 'CronCreate', { cron: '*/5 * * * *', prompt: 'check', recurring: true }, at),
      result('toolu_cron', { id: 'c1', humanSchedule: 'every 5 minutes', recurring: true, durable: false }, at),
      call('toolu_wake', 'ScheduleWakeup', { delaySeconds: 3600, prompt: 'check CI', reason: 'r' }, at),
      '',
    ].join('\n');
    assert.deepEqual(lostWorkOf(text, false, SHUTDOWN), { background: 1, crons: 1, wake: true });
    assert.deepEqual(lostWorkOf('', false, SHUTDOWN), NOTHING);
  });
});

describe('describeLostWork', () => {
  it('names each kind of work in a list', () => {
    assert.equal(describeLostWork(NOTHING), undefined);
    assert.equal(describeLostWork({ background: 1, crons: 0, wake: false }), '1 background job');
    assert.equal(describeLostWork({ background: 2, crons: 1, wake: true }), '2 background jobs, 1 cron job and a wake-up');
    assert.equal(describeLostWork({ background: 0, crons: 3, wake: true }), '3 cron jobs and a wake-up');
  });
});

describe('chooseMode', () => {
  it('continues a session that was mid-turn, hit an API error or lost work, and the lead', () => {
    assert.deepEqual(chooseMode(entry({ state: 'working' }), NOTHING, false), { mode: 'continue', why: 'mid-turn' });
    assert.deepEqual(chooseMode(entry({ state: 'error' }), { background: 0, crons: 1, wake: false }, false), {
      mode: 'continue',
      why: 'api error and 1 cron job',
    });
    assert.deepEqual(chooseMode(entry(), NOTHING, true), { mode: 'continue', why: 'lead' });
    assert.deepEqual(chooseMode(entry(), NOTHING, false), { mode: 'idle', why: 'nothing live' });
  });
});

describe('summarizeRestore', () => {
  it('lists each session with how it came back', () => {
    const summary = summarizeRestore([
      { label: 'po', mode: 'continue', why: 'mid-turn' },
      { label: 'ops', mode: 'idle', why: 'nothing live' },
    ]);
    assert.equal(summary, 'po continue (mid-turn), ops idle');
  });
});

describe('continuePrompt', () => {
  it('adds the lost work, and for the lead the other sessions', () => {
    assert.equal(continuePrompt(NOTHING, undefined), CONTINUE_PROMPT);
    assert.equal(continuePrompt({ background: 1, crons: 0, wake: false }, ''), `${CONTINUE_PROMPT} At the shutdown you had 1 background job live.`);
    assert.equal(continuePrompt(NOTHING, 'po idle'), `${CONTINUE_PROMPT} Other sessions restored: po idle.`);
  });

  it('cuts a long summary so the prompt stays within the limit', () => {
    const prompt = continuePrompt({ background: 2, crons: 1, wake: true }, 'po idle, '.repeat(400));
    assert.equal(prompt.length, PROMPT_MAX);
    assert.ok(prompt.startsWith(`${CONTINUE_PROMPT} At the shutdown you had 2 background jobs, 1 cron job and a wake-up live. Other sessions restored: po idle`));
    assert.ok(prompt.endsWith('....'));
  });
});

describe('nearestExistingFolder', () => {
  it('walks up to the nearest folder that is there', async () => {
    const root = resolve('/work');
    const probe = new FakePathProbe({ folders: [root, join(root, 'app')] });
    assert.equal(await nearestExistingFolder(join(root, 'app'), probe), join(root, 'app'));
    assert.equal(await nearestExistingFolder(join(root, 'app', '.claude', 'worktrees', 'gone'), probe), join(root, 'app'));
  });

  it('gives up at the root when nothing on the way is there', async () => {
    const gone = join(parse(resolve('/')).root, 'gone', 'deeper');
    assert.equal(await nearestExistingFolder(gone, new FakePathProbe()), undefined);
  });
});

describe('lastRecordedEffort', () => {
  const turn = (effort: string, model = 'claude-opus-5-5'): string => JSON.stringify({ type: 'assistant', effort, message: { model } });

  it('takes the newest real assistant turn that records a known level', () => {
    const text = [turn('high'), turn('max'), turn('low', '<synthetic>'), '{"type":"user"}', ''].join('\n');
    assert.equal(lastRecordedEffort(text), 'max');
  });

  it('skips unknown levels and torn lines, and is undefined with none', () => {
    assert.equal(lastRecordedEffort(`"type":"assistant","effort":"max"}\n${turn('turbo')}\n`), undefined);
    assert.equal(lastRecordedEffort(''), undefined);
  });
});
