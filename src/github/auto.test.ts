import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addedLines, addedTasks, claimState, failureNews, finishState, formatSyncState, isDue, parseSyncState, type AddedTask, type SyncState } from './auto.ts';
import type { StepOutcome } from './sync.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const MINUTE = 60_000;

function task(id: string, owner: string, title = `Issue ${id}`): AddedTask {
  return { id, owner, ref: `gh:acme/web#${id.slice(1)}`, title };
}

describe('the sync state file', () => {
  it('reads back what it wrote, with or without a finish', () => {
    for (const state of [
      { startedAt: NOW, finishedAt: undefined, failing: [] },
      { startedAt: NOW, finishedAt: NOW + MINUTE, failing: ['acme/api'] },
    ] satisfies SyncState[]) {
      assert.deepEqual(parseSyncState(formatSyncState(state)), state);
    }
  });

  it('reads a damaged file or one of another format as no sync yet', () => {
    for (const text of ['', 'not json', '{"v":2,"startedAt":1,"failing":[]}', '{"v":1,"failing":[]}', '{"v":1,"startedAt":1,"failing":[3]}', '{"v":1,"startedAt":1,"finishedAt":"x","failing":[]}']) {
      assert.equal(parseSyncState(text), undefined, text);
    }
  });
});

describe('isDue', () => {
  const state: SyncState = { startedAt: NOW, finishedAt: undefined, failing: [] };

  it('starts the first sync, then the next once everyMinutes passed since the last start, finished or not', () => {
    assert.equal(isDue(undefined, NOW, 15), true);
    assert.equal(isDue(state, NOW + 14 * MINUTE, 15), false);
    assert.equal(isDue(state, NOW + 15 * MINUTE, 15), true);
  });

  it('never starts one at 0 minutes, and a start dated ahead of now does not hold the next one off', () => {
    assert.equal(isDue(undefined, NOW, 0), false);
    assert.equal(isDue(state, NOW - MINUTE, 15), true);
  });

  it('claims the interval keeping the last failures, and a finish keeps the claimed start', () => {
    const before: SyncState = { startedAt: NOW - 20 * MINUTE, finishedAt: NOW - 19 * MINUTE, failing: ['acme/api'] };
    const claimed = claimState(before, NOW);
    assert.deepEqual(claimed, { startedAt: NOW, finishedAt: NOW - 19 * MINUTE, failing: ['acme/api'] });
    assert.deepEqual(finishState(claimed, NOW + MINUTE, []), { startedAt: NOW, finishedAt: NOW + MINUTE, failing: [] });
    assert.deepEqual(finishState(undefined, NOW, [{ repo: 'acme/web', reason: 'gone' }]), { startedAt: NOW, finishedAt: NOW, failing: ['acme/web'] });
  });
});

describe('addedTasks and addedLines', () => {
  it('takes only the adds that were written, with their owner and title', () => {
    const outcomes: StepOutcome[] = [
      { step: { kind: 'add', ref: 'gh:acme/web#7', input: { title: 'Fix login', description: null, owner: 'bravo', ref: 'gh:acme/web#7', priority: 1 } }, result: { ok: true, value: 'T5' } },
      { step: { kind: 'add', ref: 'gh:acme/web#8', input: { title: 'Add search', description: null, owner: 'lead', ref: 'gh:acme/web#8', priority: 2 } }, result: { ok: false, error: 'refused' } },
      { step: { kind: 'status', ref: 'gh:acme/web#9', id: 'T2', input: { status: 'done', note: 'closed on GitHub' } }, result: { ok: true, value: 'T2' } },
    ];
    assert.deepEqual(addedTasks(outcomes), [{ id: 'T5', owner: 'bravo', ref: 'gh:acme/web#7', title: 'Fix login' }]);
  });

  it('gives each owner one line naming its new tasks, titles quoted and cut, and counts those past five', () => {
    const lines = addedLines([task('T1', 'bravo', 'Fix "login"'), task('T2', 'lead'), ...['T3', 'T4', 'T5', 'T6', 'T7'].map((id) => task(id, 'bravo', 'x'.repeat(80)))]);
    assert.deepEqual([...lines.keys()], ['bravo', 'lead']);
    assert.equal(lines.get('lead'), 'GitHub sync added 1 task(s) for you: T2 gh:acme/web#2 "Issue T2"');
    const bravo = lines.get('bravo') ?? '';
    assert.ok(bravo.startsWith('GitHub sync added 6 task(s) for you: T1 gh:acme/web#1 "Fix \\"login\\"", T3 gh:acme/web#3 "xxx'), bravo);
    assert.ok(bravo.endsWith(', and 1 more'), bravo);
    assert.ok(!bravo.includes('x'.repeat(61)), bravo);
  });
});

describe('failureNews', () => {
  const api = { repo: 'acme/api', reason: 'GitHub refused the token\nsaved as teamrig-gh-acme' };

  it('tells a newly failing repository once, on one line, and nothing while it keeps failing', () => {
    assert.equal(
      failureNews([], [api]),
      'GitHub sync could not read acme/api (GitHub refused the token saved as teamrig-gh-acme); it retries at each run and says here when every repository reads again',
    );
    assert.equal(failureNews(['acme/api'], [api]), undefined);
  });

  it('tells only the new one when another starts failing, and when every repository reads again', () => {
    assert.match(failureNews(['acme/api'], [api, { repo: 'acme/web', reason: 'gone' }]) ?? '', /^GitHub sync could not read acme\/web \(gone\);/);
    assert.equal(failureNews(['acme/api'], []), 'GitHub sync reads every repository again (acme/api failed before)');
    assert.equal(failureNews([], []), undefined);
  });
});
