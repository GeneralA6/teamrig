import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fieldPaths } from '../testing/field-paths.ts';
import {
  addedLines,
  addedTasks,
  failureNews,
  finishState,
  formatSyncState,
  leftOutNews,
  parseSyncState,
  SYNC_STATE_FORMAT,
  type AddedTask,
  type SyncState,
} from './auto.ts';
import type { PullWatch } from './pull-news.ts';
import type { StepOutcome } from './sync.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const MINUTE = 60_000;
const NONE: ReadonlyMap<string, readonly number[]> = new Map();
const NO_PULLS: ReadonlyMap<string, PullWatch> = new Map();
const WATCH: PullWatch = {
  cursor: '2030-01-08T09:00:00Z',
  open: [
    { number: 4, mergeable: 'conflicting', checks: 'failing', review: 'changes-requested' },
    { number: 7, mergeable: 'unknown', checks: 'none', review: 'none' },
  ],
};

function task(id: string, owner: string, title = `Issue ${id}`): AddedTask {
  return { id, owner, ref: `gh:acme/web#${id.slice(1)}`, title };
}

describe('the sync state file', () => {
  const full: SyncState = {
    startedAt: NOW,
    finishedAt: NOW + MINUTE,
    failing: ['acme/api'],
    leftOut: new Map([['acme/web', [9, 12]], ['acme/api', [3]]]),
    pulls: new Map([['acme/web', WATCH], ['acme/api', { cursor: undefined, open: [] }]]),
  };

  it('writes the pinned fields of its format: a field added to the file raises SYNC_STATE_FORMAT', () => {
    const written: Readonly<Record<number, readonly string[]>> = {
      3: [
        'failing[]',
        'finishedAt',
        'leftOut.*[]',
        'pulls.*.cursor',
        'pulls.*.open[].checks',
        'pulls.*.open[].mergeable',
        'pulls.*.open[].number',
        'pulls.*.open[].review',
        'startedAt',
        'v',
      ],
    };
    assert.deepEqual(fieldPaths(JSON.parse(formatSyncState(full)), new Set(['leftOut', 'pulls'])), written[SYNC_STATE_FORMAT]);
  });

  it('reads back what it wrote, with or without a finish, a left-out issue or a pull request watch', () => {
    for (const state of [{ startedAt: NOW, finishedAt: undefined, failing: [], leftOut: NONE, pulls: NO_PULLS }, full] satisfies SyncState[]) {
      assert.deepEqual(parseSyncState(formatSyncState(state)), state);
    }
    const bare = formatSyncState({ ...full, leftOut: NONE, pulls: NO_PULLS });
    assert.ok(!bare.includes('leftOut') && !bare.includes('pulls'), bare);
  });

  it('reads a format-1 file as having left nothing out, and formats 1 and 2 as having watched no pull request', () => {
    assert.deepEqual(parseSyncState('{"v":1,"startedAt":1,"failing":["acme/api"]}'), { startedAt: 1, finishedAt: undefined, failing: ['acme/api'], leftOut: NONE, pulls: NO_PULLS });
    assert.deepEqual(parseSyncState('{"v":2,"startedAt":1,"failing":[],"leftOut":{"acme/web":[9]},"pulls":{"acme/web":7}}'), {
      startedAt: 1,
      finishedAt: undefined,
      failing: [],
      leftOut: new Map([['acme/web', [9]]]),
      pulls: NO_PULLS,
    });
  });

  it('reads a damaged file or one of another format as no sync yet', () => {
    const mark = '{"number":4,"mergeable":"mergeable","checks":"none","review":"none"}';
    for (const text of [
      '',
      'not json',
      '{"v":4,"startedAt":1,"failing":[]}',
      '{"v":3,"startedAt":1,"failing":[],"pulls":[]}',
      '{"v":3,"startedAt":1,"failing":[],"pulls":{"acme/web":7}}',
      '{"v":3,"startedAt":1,"failing":[],"pulls":{"acme/web":{"cursor":"x","open":[]}}}',
      '{"v":3,"startedAt":1,"failing":[],"pulls":{"acme/web":{"cursor":9,"open":[]}}}',
      '{"v":3,"startedAt":1,"failing":[],"pulls":{"acme/web":{"open":{}}}}',
      `{"v":3,"startedAt":1,"failing":[],"pulls":{"acme/web":{"open":[${mark.replace('4', '0')}]}}}`,
      `{"v":3,"startedAt":1,"failing":[],"pulls":{"acme/web":{"open":[${mark.replace('4', '4.5')}]}}}`,
      `{"v":3,"startedAt":1,"failing":[],"pulls":{"acme/web":{"open":[${mark.replace('"mergeable","checks"', '"clean","checks"')}]}}}`,
      `{"v":3,"startedAt":1,"failing":[],"pulls":{"acme/web":{"open":[${mark.replace('"none","review"', '"red","review"')}]}}}`,
      `{"v":3,"startedAt":1,"failing":[],"pulls":{"acme/web":{"open":[${mark.replace('"review":"none"', '"review":"ok"')}]}}}`,
      '{"v":3,"startedAt":1,"failing":[],"pulls":{"acme/web":{"open":[7]}}}',
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

describe('finishState', () => {
  it('records the finish, the failures and the watches, keeping the recorded start', () => {
    const claimed: SyncState = { startedAt: NOW, finishedAt: NOW - 19 * MINUTE, failing: ['acme/api'], leftOut: new Map([['acme/web', [9]]]), pulls: NO_PULLS };
    assert.deepEqual(finishState(claimed, NOW + MINUTE, { failures: [], leftOut: NONE, pulls: NO_PULLS }), {
      startedAt: NOW,
      finishedAt: NOW + MINUTE,
      failing: [],
      leftOut: NONE,
      pulls: NO_PULLS,
    });
    assert.deepEqual(finishState(undefined, NOW, { failures: [{ repo: 'acme/web', reason: 'gone' }], leftOut: NONE, pulls: NO_PULLS }), {
      startedAt: NOW,
      finishedAt: NOW,
      failing: ['acme/web'],
      leftOut: NONE,
      pulls: NO_PULLS,
    });
  });

  it('keeps what was left out of a repository it could not read, and drops a read one that left nothing out', () => {
    const before: SyncState = { startedAt: NOW, finishedAt: undefined, failing: [], leftOut: new Map([['acme/web', [9]], ['acme/api', [3]], ['acme/old', [1]]]), pulls: NO_PULLS };
    const failed = [{ repo: 'acme/web', reason: 'gone' }];
    const finished = finishState(before, NOW + MINUTE, { failures: failed, leftOut: new Map([['acme/api', []], ['acme/new', [4, 5]]]), pulls: NO_PULLS });
    assert.deepEqual(finished.leftOut, new Map([['acme/new', [4, 5]], ['acme/web', [9]]]));
  });

  it('keeps the pull request watch of a repository it could not read, and drops one no longer synced', () => {
    const empty: PullWatch = { cursor: undefined, open: [] };
    const before: SyncState = { startedAt: NOW, finishedAt: undefined, failing: [], leftOut: NONE, pulls: new Map([['acme/web', WATCH], ['acme/api', WATCH], ['acme/old', WATCH]]) };
    const failed = [{ repo: 'acme/web', reason: 'gone' }];
    const finished = finishState(before, NOW + MINUTE, { failures: failed, leftOut: NONE, pulls: new Map([['acme/api', empty], ['acme/new', empty]]) });
    assert.deepEqual(finished.pulls, new Map([['acme/api', empty], ['acme/new', empty], ['acme/web', WATCH]]));
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
