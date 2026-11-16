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
import type { IssueMark } from './issue-marks.ts';
import type { MentionWatch } from './mention-route.ts';
import type { PullWatch } from './pull-news.ts';
import type { SecurityIssue } from './security-alert.ts';
import type { StepOutcome } from './sync.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const MINUTE = 60_000;
const NONE: ReadonlyMap<string, readonly number[]> = new Map();
const NO_PULLS: ReadonlyMap<string, PullWatch> = new Map();
const NO_SECURITY: ReadonlyMap<string, readonly SecurityIssue[]> = new Map();
const NO_MENTIONS: ReadonlyMap<string, MentionWatch> = new Map();
const NO_WAKES: ReadonlyMap<string, number> = new Map();
const NO_MARKS: ReadonlyMap<string, ReadonlyMap<number, IssueMark>> = new Map();
/** A state's mention and issue mark fields when no repository's posts or watched issues were read yet. */
const UNSCANNED = { mentions: NO_MENTIONS, mentionWakes: NO_WAKES, issues: NO_MARKS };
const NO_ISSUE_MARKS: ReadonlyMap<number, IssueMark> = new Map();
const MARKS: ReadonlyMap<number, IssueMark> = new Map([[9, { open: false, labels: ['bug', 'ui'] }]]);
const SCAN: MentionWatch = { cursor: '2030-01-08T09:00:00Z', seen: new Map([['comment:11', { logins: ['octocat', 'hubber'], updatedAt: '2030-01-08T08:30:00Z' }]]) };
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
    paged: new Map([['acme/web', [5, 8]]]),
    mentions: new Map([['acme/web', SCAN], ['acme/api', { cursor: '2030-01-08T09:00:00Z', seen: new Map() }]]),
    mentionWakes: new Map([['bravo gh:acme/web#7', NOW]]),
    issues: new Map([['acme/web', MARKS]]),
  };

  it('writes the pinned fields of its format: a field added to the file raises SYNC_STATE_FORMAT', () => {
    const written: Readonly<Record<number, readonly string[]>> = {
      6: [
        'failing[]',
        'finishedAt',
        'issues.*.*.labels[]',
        'issues.*.*.open',
        'leftOut.*[]',
        'mentionWakes.*',
        'mentions.*.cursor',
        'mentions.*.seen.*.logins[]',
        'mentions.*.seen.*.updatedAt',
        'paged.*[]',
        'pulls.*.cursor',
        'pulls.*.open[].checks',
        'pulls.*.open[].mergeable',
        'pulls.*.open[].number',
        'pulls.*.open[].review',
        'startedAt',
        'v',
      ],
    };
    assert.deepEqual(fieldPaths(JSON.parse(formatSyncState(full)), new Set(['leftOut', 'pulls', 'paged', 'mentions', 'mentionWakes', 'mentions.*.seen', 'issues', 'issues.*'])), written[SYNC_STATE_FORMAT]);
  });

  it('reads back what it wrote, with or without a finish, a left-out issue, a pull request watch, a paged issue or a mention watch', () => {
    for (const state of [{ startedAt: NOW, finishedAt: undefined, failing: [], leftOut: NONE, pulls: NO_PULLS, paged: NONE, ...UNSCANNED }, full] satisfies SyncState[]) {
      assert.deepEqual(parseSyncState(formatSyncState(state)), state);
    }
    const bare = formatSyncState({ ...full, leftOut: NONE, pulls: NO_PULLS, paged: NONE, ...UNSCANNED });
    assert.ok(!bare.includes('leftOut') && !bare.includes('pulls') && !bare.includes('paged') && !bare.includes('mention') && !bare.includes('issues'), bare);
  });

  it('reads a format-1 file as having left nothing out, formats 1 and 2 as having watched no pull request, none before 4 as having paged and none before 5 as having watched a mention', () => {
    assert.deepEqual(parseSyncState('{"v":1,"startedAt":1,"failing":["acme/api"]}'), { startedAt: 1, finishedAt: undefined, failing: ['acme/api'], leftOut: NONE, pulls: NO_PULLS, paged: NONE, ...UNSCANNED });
    assert.deepEqual(parseSyncState('{"v":2,"startedAt":1,"failing":[],"leftOut":{"acme/web":[9]},"pulls":{"acme/web":7}}'), {
      startedAt: 1,
      finishedAt: undefined,
      failing: [],
      leftOut: new Map([['acme/web', [9]]]),
      pulls: NO_PULLS,
      paged: NONE,
      ...UNSCANNED,
    });
    assert.deepEqual(parseSyncState('{"v":3,"startedAt":1,"failing":[],"pulls":{"acme/web":{"open":[]}},"paged":{"acme/web":[5]}}')?.paged, NONE);
    const four = parseSyncState('{"v":4,"startedAt":1,"failing":[],"paged":{"acme/web":[5]},"mentions":{"acme/web":7}}');
    assert.deepEqual([four?.paged, four?.mentions, four?.mentionWakes], [new Map([['acme/web', [5]]]), NO_MENTIONS, NO_WAKES]);
    const five = parseSyncState('{"v":5,"startedAt":1,"failing":[],"mentionWakes":{"bravo gh:acme/web#7":1},"issues":{"acme/web":7}}');
    assert.deepEqual([five?.mentionWakes, five?.issues], [new Map([['bravo gh:acme/web#7', 1]]), NO_MARKS]);
  });

  it('reads a damaged file or one of another format as no sync yet', () => {
    const mark = '{"number":4,"mergeable":"mergeable","checks":"none","review":"none"}';
    for (const text of [
      '',
      'not json',
      '{"v":7,"startedAt":1,"failing":[]}',
      '{"v":6,"startedAt":1,"failing":[],"issues":[]}',
      '{"v":6,"startedAt":1,"failing":[],"issues":{"acme/web":[]}}',
      '{"v":6,"startedAt":1,"failing":[],"issues":{"acme/web":{"x":{"open":true,"labels":[]}}}}',
      '{"v":6,"startedAt":1,"failing":[],"issues":{"acme/web":{"9":{"open":"yes","labels":[]}}}}',
      '{"v":6,"startedAt":1,"failing":[],"issues":{"acme/web":{"9":{"open":true,"labels":[1]}}}}',
      '{"v":5,"startedAt":1,"failing":[],"mentions":[]}',
      '{"v":5,"startedAt":1,"failing":[],"mentions":{"acme/web":{"seen":{}}}}',
      '{"v":5,"startedAt":1,"failing":[],"mentions":{"acme/web":{"cursor":"x","seen":{}}}}',
      '{"v":5,"startedAt":1,"failing":[],"mentions":{"acme/web":{"cursor":"2030-01-01T00:00:00Z","seen":[]}}}',
      '{"v":5,"startedAt":1,"failing":[],"mentions":{"acme/web":{"cursor":"2030-01-01T00:00:00Z","seen":{"comment:1":{"logins":["a"]}}}}}',
      '{"v":5,"startedAt":1,"failing":[],"mentions":{"acme/web":{"cursor":"2030-01-01T00:00:00Z","seen":{"comment:1":{"logins":[1],"updatedAt":"2030-01-01T00:00:00Z"}}}}}',
      '{"v":5,"startedAt":1,"failing":[],"mentionWakes":{"bravo gh:acme/web#7":"x"}}',
      '{"v":5,"startedAt":1,"failing":[],"mentionWakes":[]}',
      '{"v":4,"startedAt":1,"failing":[],"paged":[5]}',
      '{"v":4,"startedAt":1,"failing":[],"paged":{"acme/web":["5"]}}',
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
  it('records the finish, the failures and the watches, keeping the recorded start and the paged numbers', () => {
    const paged = new Map([['acme/web', [5]]]);
    const claimed: SyncState = { startedAt: NOW, finishedAt: NOW - 19 * MINUTE, failing: ['acme/api'], leftOut: new Map([['acme/web', [9]]]), pulls: NO_PULLS, paged, ...UNSCANNED };
    assert.deepEqual(finishState(claimed, NOW + MINUTE, { failures: [], leftOut: NONE, pulls: NO_PULLS, security: NO_SECURITY, mentions: NO_MENTIONS, issues: NO_MARKS }, NO_WAKES), {
      startedAt: NOW,
      finishedAt: NOW + MINUTE,
      failing: [],
      leftOut: NONE,
      pulls: NO_PULLS,
      paged,
      ...UNSCANNED,
    });
    assert.deepEqual(finishState(undefined, NOW, { failures: [{ repo: 'acme/web', reason: 'gone' }], leftOut: NONE, pulls: NO_PULLS, security: NO_SECURITY, mentions: NO_MENTIONS, issues: NO_MARKS }, NO_WAKES), {
      startedAt: NOW,
      finishedAt: NOW,
      failing: ['acme/web'],
      leftOut: NONE,
      pulls: NO_PULLS,
      paged: NONE,
      ...UNSCANNED,
    });
  });

  it('keeps what was left out of a repository it could not read, and drops a read one that left nothing out', () => {
    const before: SyncState = { startedAt: NOW, finishedAt: undefined, failing: [], leftOut: new Map([['acme/web', [9]], ['acme/api', [3]], ['acme/old', [1]]]), pulls: NO_PULLS, paged: NONE, ...UNSCANNED };
    const failed = [{ repo: 'acme/web', reason: 'gone' }];
    const finished = finishState(before, NOW + MINUTE, { failures: failed, leftOut: new Map([['acme/api', []], ['acme/new', [4, 5]]]), pulls: NO_PULLS, security: NO_SECURITY, mentions: NO_MENTIONS, issues: NO_MARKS }, NO_WAKES);
    assert.deepEqual(finished.leftOut, new Map([['acme/new', [4, 5]], ['acme/web', [9]]]));
  });

  it('keeps the pull request watch of a repository it could not read, and drops one no longer synced', () => {
    const empty: PullWatch = { cursor: undefined, open: [] };
    const before: SyncState = { startedAt: NOW, finishedAt: undefined, failing: [], leftOut: NONE, pulls: new Map([['acme/web', WATCH], ['acme/api', WATCH], ['acme/old', WATCH]]), paged: NONE, ...UNSCANNED };
    const failed = [{ repo: 'acme/web', reason: 'gone' }];
    const finished = finishState(before, NOW + MINUTE, { failures: failed, leftOut: NONE, pulls: new Map([['acme/api', empty], ['acme/new', empty]]), security: NO_SECURITY, mentions: NO_MENTIONS, issues: NO_MARKS }, NO_WAKES);
    assert.deepEqual(finished.pulls, new Map([['acme/api', empty], ['acme/new', empty], ['acme/web', WATCH]]));
  });

  it('keeps the mention watch of a repository it could not read, drops one no longer synced, and writes the wakes it is given', () => {
    const fresh: MentionWatch = { cursor: '2030-01-08T10:00:00Z', seen: new Map() };
    const before: SyncState = { startedAt: NOW, finishedAt: undefined, failing: [], leftOut: NONE, pulls: NO_PULLS, paged: NONE, mentions: new Map([['acme/web', SCAN], ['acme/api', SCAN], ['acme/old', SCAN]]), mentionWakes: new Map([['bravo gh:acme/web#7', NOW - MINUTE]]), issues: NO_MARKS };
    const wakes = new Map([['charlie gh:acme/api#3', NOW]]);
    const finished = finishState(before, NOW + MINUTE, { failures: [{ repo: 'acme/web', reason: 'gone' }], leftOut: NONE, pulls: NO_PULLS, security: NO_SECURITY, mentions: new Map([['acme/api', fresh]]), issues: NO_MARKS }, wakes);
    assert.deepEqual([finished.mentions, finished.mentionWakes], [new Map([['acme/api', fresh], ['acme/web', SCAN]]), wakes]);
  });

  it('keeps the issue marks of a repository it could not read, and drops one no longer synced', () => {
    const before: SyncState = { startedAt: NOW, finishedAt: undefined, failing: [], leftOut: NONE, pulls: NO_PULLS, paged: NONE, ...UNSCANNED, issues: new Map([['acme/web', MARKS], ['acme/api', MARKS], ['acme/old', MARKS]]) };
    const run = { failures: [{ repo: 'acme/web', reason: 'gone' }], leftOut: NONE, pulls: NO_PULLS, security: NO_SECURITY, mentions: NO_MENTIONS, issues: new Map([['acme/api', NO_ISSUE_MARKS]]) };
    assert.deepEqual(finishState(before, NOW + MINUTE, run, NO_WAKES).issues, new Map<string, ReadonlyMap<number, IssueMark>>([['acme/api', NO_ISSUE_MARKS], ['acme/web', MARKS]]));
  });

  it('keeps every number paged before, of any repository, and adds the open security issues this run found', () => {
    const before: SyncState = { startedAt: NOW, finishedAt: undefined, failing: [], leftOut: NONE, pulls: NO_PULLS, paged: new Map([['acme/web', [3]], ['acme/api', [2]], ['acme/old', [1]]]), ...UNSCANNED };
    const security = new Map([['acme/web', [{ repo: 'acme/web', number: 8, url: 'https://github.com/acme/web/issues/8', to: 'bravo' }, { repo: 'acme/web', number: 5, url: 'https://github.com/acme/web/issues/5', to: 'bravo' }]], ['acme/old', []]]);
    const finished = finishState(before, NOW + MINUTE, { failures: [{ repo: 'acme/api', reason: 'gone' }], leftOut: NONE, pulls: NO_PULLS, security, mentions: NO_MENTIONS, issues: NO_MARKS }, NO_WAKES);
    assert.deepEqual(finished.paged, new Map([['acme/web', [3, 5, 8]], ['acme/api', [2]], ['acme/old', [1]]]));
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
