import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fieldPaths } from '../testing/field-paths.ts';
import {
  addedLines,
  addedTasks,
  claimState,
  failureNews,
  finishState,
  formatSyncState,
  isDue,
  leftOutNews,
  parseSyncState,
  SYNC_STATE_FORMAT,
  type AddedTask,
  type SyncState,
} from './auto.ts';
import type { StepOutcome } from './sync.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const MINUTE = 60_000;
const NONE: ReadonlyMap<string, readonly number[]> = new Map();

function task(id: string, owner: string, title = `Issue ${id}`): AddedTask {
  return { id, owner, ref: `gh:acme/web#${id.slice(1)}`, title };
}

describe('the sync state file', () => {
  const full: SyncState = { startedAt: NOW, finishedAt: NOW + MINUTE, failing: ['acme/api'], leftOut: new Map([['acme/web', [9, 12]], ['acme/api', [3]]]) };

  it('writes the pinned fields of its format: a field added to the file raises SYNC_STATE_FORMAT', () => {
    const written: Readonly<Record<number, readonly string[]>> = {
      2: ['failing[]', 'finishedAt', 'leftOut.*[]', 'startedAt', 'v'],
    };
    assert.deepEqual(fieldPaths(JSON.parse(formatSyncState(full)), new Set(['leftOut'])), written[SYNC_STATE_FORMAT]);
  });

  it('reads back what it wrote, with or without a finish or a left-out issue', () => {
    for (const state of [{ startedAt: NOW, finishedAt: undefined, failing: [], leftOut: NONE }, full] satisfies SyncState[]) {
      assert.deepEqual(parseSyncState(formatSyncState(state)), state);
    }
    assert.ok(!formatSyncState({ ...full, leftOut: NONE }).includes('leftOut'));
  });

  it('reads a format-1 file as having left nothing out', () => {
    assert.deepEqual(parseSyncState('{"v":1,"startedAt":1,"failing":["acme/api"]}'), { startedAt: 1, finishedAt: undefined, failing: ['acme/api'], leftOut: NONE });
  });

  it('reads a damaged file or one of another format as no sync yet', () => {
    for (const text of [
      '',
      'not json',
      '{"v":3,"startedAt":1,"failing":[]}',
      '{"v":1,"failing":[]}',
      '{"v":1,"startedAt":1,"failing":[3]}',
      '{"v":1,"startedAt":1,"finishedAt":"x","failing":[]}',
      '{"v":2,"startedAt":1,"failing":[],"leftOut":[9]}',
      '{"v":2,"startedAt":1,"failing":[],"leftOut":{"acme/web":["9"]}}',
      '{"v":2,"startedAt":1,"failing":[],"leftOut":{"acme/web":[1.5]}}',
      '{"v":2,"startedAt":1,"failing":[],"leftOut":{"acme/web":9}}',
    ]) {
      assert.equal(parseSyncState(text), undefined, text);
    }
  });
});

describe('isDue', () => {
  const state: SyncState = { startedAt: NOW, finishedAt: undefined, failing: [], leftOut: NONE };

  it('starts the first sync, then the next once everyMinutes passed since the last start, finished or not', () => {
    assert.equal(isDue(undefined, NOW, 15), true);
    assert.equal(isDue(state, NOW + 14 * MINUTE, 15), false);
    assert.equal(isDue(state, NOW + 15 * MINUTE, 15), true);
  });

  it('never starts one at 0 minutes, and a start dated ahead of now does not hold the next one off', () => {
    assert.equal(isDue(undefined, NOW, 0), false);
    assert.equal(isDue(state, NOW - MINUTE, 15), true);
  });

  it('claims the interval keeping the last failures and left-out issues, and a finish keeps the claimed start', () => {
    const leftOut = new Map([['acme/web', [9]]]);
    const before: SyncState = { startedAt: NOW - 20 * MINUTE, finishedAt: NOW - 19 * MINUTE, failing: ['acme/api'], leftOut };
    const claimed = claimState(before, NOW);
    assert.deepEqual(claimed, { startedAt: NOW, finishedAt: NOW - 19 * MINUTE, failing: ['acme/api'], leftOut });
    assert.deepEqual(finishState(claimed, NOW + MINUTE, [], NONE), { startedAt: NOW, finishedAt: NOW + MINUTE, failing: [], leftOut: NONE });
    assert.deepEqual(finishState(undefined, NOW, [{ repo: 'acme/web', reason: 'gone' }], NONE), { startedAt: NOW, finishedAt: NOW, failing: ['acme/web'], leftOut: NONE });
  });

  it('keeps what was left out of a repository it could not read, and drops a read one that left nothing out', () => {
    const before: SyncState = { startedAt: NOW, finishedAt: undefined, failing: [], leftOut: new Map([['acme/web', [9]], ['acme/api', [3]], ['acme/old', [1]]]) };
    const failed = [{ repo: 'acme/web', reason: 'gone' }];
    const finished = finishState(before, NOW + MINUTE, failed, new Map([['acme/api', []], ['acme/new', [4, 5]]]));
    assert.deepEqual(finished.leftOut, new Map([['acme/new', [4, 5]], ['acme/web', [9]]]));
  });
});

describe('leftOutNews', () => {
  it('names only the issues not left out before, by ref, with the label that lets one in', () => {
    const before = new Map([['acme/web', [9]]]);
    assert.equal(leftOutNews(before, before, 'teamrig'), undefined);
    assert.equal(leftOutNews(before, NONE, 'teamrig'), undefined);
    assert.equal(
      leftOutNews(before, new Map([['acme/web', [9, 12]], ['acme/api', [3]]]), 'triaged'),
      'GitHub sync left out 2 new open issue(s) by people outside the repository: gh:acme/web#12, gh:acme/api#3; add the "triaged" label to one on GitHub to make it a task at the next sync',
    );
  });

  it('names at most ten and counts the rest', () => {
    const news = leftOutNews(NONE, new Map([['acme/web', Array.from({ length: 12 }, (_, index) => index + 1)]]), 'teamrig') ?? '';
    assert.match(news, /^GitHub sync left out 12 new open issue\(s\) by people outside the repository: gh:acme\/web#1, .*gh:acme\/web#10, and 2 more; /);
    assert.ok(!news.includes('#11'), news);
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
