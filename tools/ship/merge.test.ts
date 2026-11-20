import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import type { MergeClearance, WorkCommit } from './approval.ts';
import type { CatchUp } from './catch-up.ts';
import type { Gh, RequiredChecks } from './github.ts';
import type { Credential } from './keychain.ts';
import type { GateDeps } from './local-gate.ts';
import { type MainBranch, type MergeArgs, type MergeDeps, type MergeRequest, type MergeResult, type Waiter, MERGE_ATTEMPTS, ciProof,mainBranchOf, mergeBranch, mergeCommand, mergeRun, mergeThroughPull, parseArgs, pullBody, realMergeDeps, runMerge, missingSections, stepShareOf, waitForChecks } from './merge.ts';
import type { PullTask } from './pull-task.ts';
import { parseProfiles } from './repos.ts';
import type { Supersede } from './superseded.ts';
import { TempRepo } from '../lib/temp-repo.ts';

const REPO = 'Owner/repo';
const GH_SECRET = ['github', '_pat_', 'x'].join('');
const SHA = 'abc1234def';
/** The branch mergeThroughPull merges in these tests, and the one the fake GitHub's run checked. */
const HEAD = 'dev';
/** The main SHA was cut from; MOVED is a later main that SHA does not contain. */
const BASE = 'base000aaa';
const MOVED = 'moved00bbb';
const MINUTE = 60_000;
/** The branch's task in the register, linked to issue #9 of REPO (whose name GitHub reads lower-cased). */
const TASK: PullTask = { id: 'T1', priority: 1, type: null, ref: `gh:${REPO}#9` };
const ISSUE_PATH = `repos/${REPO.toLowerCase()}/issues/9`;

/**
 * main on origin: each tip read takes the next of `tips` (the last repeats), and SHA contains BASE only.
 * The merged commit holds `mergedTree` (SHA's tree unless given); every tree read throws `treeError` when given.
 */
function fakeMain(options: { tips?: readonly string[]; mergedTree?: string; treeError?: Error | string } = {}): MainBranch & { reads: string[] } {
  const tips = options.tips ?? [BASE];
  const reads: string[] = [];
  return {
    reads,
    tip: () => {
      const tip = tips[Math.min(reads.length, tips.length - 1)] ?? BASE;
      reads.push(tip);
      return tip;
    },
    contains: (sha, ancestor) => sha === SHA && ancestor === BASE,
    treeOf: sha => {
      if (options.treeError !== undefined) throw options.treeError;
      return sha === SHA ? 'tree-checked' : (options.mergedTree ?? 'tree-checked');
    },
  };
}

/** A clock that only moves when the code under test sleeps. */
function fakeWaiter(): Waiter & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async ms => {
      slept.push(ms);
      now += ms;
    },
  };
}

/** A job's name, status and conclusion; `unstarted` gives it no steps, as GitHub shows a job that never got a runner. */
type JobState = readonly [name: string, status: string, conclusion: string | null, unstarted?: 'unstarted'];

/** A head pushed for a pull request: the sha GitHub opens it at, and the branch its workflow run names. */
interface PushedHead {
  readonly sha: string;
  readonly branch: string;
}

interface FakeGitHub {
  gh: ReturnType<typeof mock.fn<Gh>>;
  writes: string[][];
}

const RERUN_PATH = `repos/${REPO}/actions/runs/1/rerun-failed-jobs`;

/**
 * GitHub with one workflow run whose jobs move through `rounds`, one round per read of the jobs. A re-run of the run
 * makes its next attempt, or throws `rerun` when given. Each merge call answers the next of `merges` (the last
 * repeats) when given, else `merge`.
 */
function fakeGitHub(options: { rounds: readonly (readonly JobState[])[]; openPullSha?: string | null; openedSha?: string; merge?: string | Error; merges?: readonly (string | Error)[]; rerun?: Error; branch?: string; heads?: readonly PushedHead[]; repoLabels?: readonly string[] }): FakeGitHub {
  const writes: string[][] = [];
  let round = 0;
  let attempt = 1;
  let mergeCalls = 0;
  let opened = 0;
  const openedHead = (): PushedHead | undefined => options.heads?.[Math.min(opened++, options.heads.length - 1)];
  const branchOf = (path: string): string | undefined => options.heads?.find(head => path.includes(`head_sha=${head.sha}`))?.branch;
  const pull = (sha: string): string => JSON.stringify({ number: 3, html_url: `https://github.com/${REPO}/pull/3`, head: { ref: 'dev', sha }, base: { ref: 'main' } });
  const gh = mock.fn<Gh>(args => {
    const path = args[1] ?? '';
    if (args.includes('-X')) writes.push([...args]);
    if (path.startsWith(`repos/${REPO}/pulls?state=open`)) return options.openPullSha === null || options.openPullSha === undefined ? '[]' : `[${pull(options.openPullSha)}]`;
    if (path === `repos/${REPO}/pulls`) return pull(openedHead()?.sha ?? options.openedSha ?? SHA);
    if (path === `repos/${REPO}/pulls/3/merge`) {
      const answer = options.merges === undefined ? options.merge : options.merges[Math.min(mergeCalls, options.merges.length - 1)];
      mergeCalls += 1;
      if (answer instanceof Error) throw answer;
      return answer ?? '{"sha":"main999","merged":true,"message":"merged"}';
    }
    if (path === RERUN_PATH) {
      if (options.rerun !== undefined) throw options.rerun;
      attempt += 1;
      return '';
    }
    if (path.includes('/actions/runs?head_sha=')) {
      return JSON.stringify({ workflow_runs: [{ id: 1, workflow_id: 1, event: 'pull_request', run_number: 1, run_attempt: attempt, head_branch: branchOf(path) ?? options.branch ?? HEAD }] });
    }
    if (path.includes('/actions/runs/1/jobs')) {
      const jobs = options.rounds[Math.min(round, options.rounds.length - 1)] ?? [];
      round += 1;
      return JSON.stringify({ jobs: jobs.map(([name, status, conclusion, unstarted]) => ({ name, status, conclusion, steps: unstarted === undefined ? [{ name: 'Set up job' }] : [] })) });
    }
    if (path.endsWith('/status')) return '{"statuses":[]}';
    if (path === ISSUE_PATH) return JSON.stringify({ title: 'Ship titles', labels: [{ name: 'area:cli' }, { name: 'p3' }] });
    if (path === `repos/${REPO}/labels?per_page=100`) return JSON.stringify((options.repoLabels ?? []).map(name => ({ name })));
    if (path === `repos/${REPO}/issues/3/labels`) return '[]';
    throw new Error(`unexpected gh ${args.join(' ')}`);
  });
  return { gh, writes };
}

const request = (overrides: Partial<MergeRequest> = {}): MergeRequest => ({
  repo: REPO,
  head: HEAD,
  base: 'main',
  sha: SHA,
  title: 'Merge dev into main: 2 commit(s)',
  body: '- a\n- b',
  lacks: null,
  opens: true,
  labels: [],
  unlinked: null,
  ...overrides,
});

const POLLING = { timeoutMs: 10 * MINUTE, intervalMs: MINUTE };
const CHECKS: RequiredChecks = { names: ['gates', 'test'], summary: null, flaky: [], conditional: [] };

/** mergeThroughPull on the `ci` gate: checks gates and test on GitHub. */
const mergeOnCi = (gh: Gh, main: MainBranch, log: (line: string) => void, lacks: string | null = null, supersede: Supersede = () => undefined): Promise<MergeResult> =>
  mergeThroughPull(request({ lacks }), gh, main, ciProof(gh, REPO, HEAD, CHECKS, fakeWaiter(), POLLING), log, supersede);

const green: readonly JobState[] = [
  ['gates', 'completed', 'success'],
  ['test', 'completed', 'success'],
];

test('waits while checks run and returns once all are green', async () => {
  const { gh } = fakeGitHub({ rounds: [[['gates', 'queued', null]], [['gates', 'completed', 'success'], ['test', 'in_progress', null]], green] });
  const waiter = fakeWaiter();
  const result = await waitForChecks(gh, REPO, SHA, HEAD, CHECKS,waiter, { timeoutMs: 10 * MINUTE, intervalMs: MINUTE });
  assert.equal(result.verdict, 'passed');
  assert.deepEqual(waiter.slept, [MINUTE, MINUTE]);
});

test('a failed check stops the wait at once', async () => {
  const { gh } = fakeGitHub({ rounds: [[['gates', 'completed', 'failure'], ['test', 'queued', null]]] });
  const waiter = fakeWaiter();
  assert.equal((await waitForChecks(gh, REPO, SHA, HEAD, CHECKS,waiter, { timeoutMs: 10 * MINUTE, intervalMs: MINUTE })).verdict, 'failed');
  assert.deepEqual(waiter.slept, []);
});

test('a check still missing at the deadline times out, and the last sleep stops at the deadline', async () => {
  const { gh } = fakeGitHub({ rounds: [[['gates', 'completed', 'success']]] });
  const waiter = fakeWaiter();
  const result = await waitForChecks(gh, REPO, SHA, HEAD, CHECKS,waiter, { timeoutMs: 150_000, intervalMs: MINUTE });
  assert.equal(result.verdict, 'timeout');
  assert.deepEqual(waiter.slept, [MINUTE, MINUTE, 30_000]);
  assert.deepEqual(result.outcomes.map(({ state }) => state), ['passed', 'missing']);
});

test('opens the pull request, waits for green and rebase-merges the checked sha', async () => {
  const { gh, writes } = fakeGitHub({ rounds: [green] });
  const log: string[] = [];
  const result = await mergeOnCi(gh, fakeMain(), line => log.push(line));
  assert.deepEqual(result.kind === 'merged' ? [result.pull.number, result.sha] : result, [3, 'main999']);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0]?.slice(0, 4), ['api', `repos/${REPO}/pulls`, '-X', 'POST']);
  assert.deepEqual(writes[1], ['api', `repos/${REPO}/pulls/3/merge`, '-X', 'PUT', '-f', 'merge_method=rebase', '-f', `sha=${SHA}`]);
  assert.deepEqual(log, [`opened pull request #3 https://github.com/${REPO}/pull/3`, 'check passed: gates (success)', 'check passed: test (success)']);
});

test('reuses an open pull request instead of opening a second one', async () => {
  const { gh, writes } = fakeGitHub({ rounds: [green], openPullSha: SHA });
  const log: string[] = [];
  assert.equal((await mergeOnCi(gh, fakeMain(), line => log.push(line))).kind, 'merged');
  assert.equal(writes.length, 1);
  assert.match(log[0] ?? '', /^found pull request #3/);
});

test('hands the pull request it opened or found to supersede once, before its checks run (T4780)', async () => {
  for (const openPullSha of [null, SHA]) {
    const log: string[] = [];
    const seen: string[][] = [];
    const supersede = mock.fn<Supersede>(() => {
      seen.push([...log]);
    });
    assert.equal((await mergeOnCi(fakeGitHub({ rounds: [green], openPullSha }).gh, fakeMain(), line => log.push(line), null, supersede)).kind, 'merged');
    assert.deepEqual(supersede.mock.calls.map(call => call.arguments[0].number), [3]);
    assert.deepEqual(seen, [[`${openPullSha === null ? 'opened' : 'found'} pull request #3 https://github.com/${REPO}/pull/3`]]);
  }
});

test('supersedes nothing for a pull request at another head, or for the release pull request', async () => {
  const supersede = mock.fn<Supersede>();
  const moved = await mergeOnCi(fakeGitHub({ rounds: [green], openPullSha: 'other99' }).gh, fakeMain(), () => undefined, null, supersede);
  assert.equal(moved.kind, 'refused');
  const { gh } = fakeGitHub({ rounds: [green], openPullSha: SHA });
  const release = await mergeThroughPull(request({ opens: false }), gh, fakeMain(), ciProof(gh, REPO, HEAD, CHECKS, fakeWaiter(), POLLING), () => undefined, supersede);
  assert.equal(release.kind, 'merged');
  assert.equal(supersede.mock.callCount(), 0);
});

test('opens no pull request whose body lacks a section the repo asks for, but merges one already open with a warning', async () => {
  const fresh = fakeGitHub({ rounds: [green] });
  const refused = await mergeOnCi(fresh.gh, fakeMain(), () => undefined, '## Reach');
  const reason = "the pull request would lack ## Reach, which this repo's template asks for: write it in a --note-file and ship again";
  assert.deepEqual(refused.kind === 'refused' ? refused.reason : refused, reason);
  assert.equal(fresh.writes.length, 0);
  const open = fakeGitHub({ rounds: [green], openPullSha: SHA });
  const log: string[] = [];
  assert.equal((await mergeOnCi(open.gh, fakeMain(), line => log.push(line), '## Reach')).kind, 'merged');
  assert.equal(log[1], "warning: pull request #3 lacks ## Reach, which this repo's template asks for: add it to its text");
});

/** mergeThroughPull on the `ci` gate for `overrides` of the request. */
const mergeRequestOnCi = (gh: Gh, overrides: Partial<MergeRequest>, log: (line: string) => void): Promise<MergeResult> =>
  mergeThroughPull(request(overrides), gh, fakeMain(), ciProof(gh, REPO, HEAD, CHECKS, fakeWaiter(), POLLING), log, () => undefined);

test('opens no pull request for a task that links no issue, but merges one already open with a warning (T4796)', async () => {
  const unlinked = 'T1 links no GitHub issue, so its pull request would close none';
  const fresh = fakeGitHub({ rounds: [green] });
  const refused = await mergeRequestOnCi(fresh.gh, { unlinked }, () => undefined);
  assert.deepEqual(refused.kind === 'refused' ? refused.reason : refused, unlinked);
  assert.equal(fresh.writes.length, 0);
  const open = fakeGitHub({ rounds: [green], openPullSha: SHA });
  const log: string[] = [];
  assert.equal((await mergeRequestOnCi(open.gh, { unlinked }, line => log.push(line))).kind, 'merged');
  assert.equal(log[1], `warning: pull request #3: ${unlinked}`);
});

test('labels the pull request it opened or found at the head before its checks run, and none at another head (T4796)', async () => {
  const labelsPath = `repos/${REPO}/issues/3/labels`;
  for (const openPullSha of [null, SHA]) {
    const { gh, writes } = fakeGitHub({ rounds: [green], openPullSha });
    const log: string[] = [];
    assert.equal((await mergeRequestOnCi(gh, { labels: ['p1', 'area:cli'] }, line => log.push(line))).kind, 'merged');
    assert.deepEqual(writes.map(write => write[1]), [...(openPullSha === null ? [`repos/${REPO}/pulls`] : []), labelsPath, `repos/${REPO}/pulls/3/merge`]);
    assert.deepEqual(writes.find(write => write[1] === labelsPath)?.slice(2), ['-X', 'POST', '-f', 'labels[]=p1', '-f', 'labels[]=area:cli']);
    assert.deepEqual(log.slice(0, 3), [`${openPullSha === null ? 'opened' : 'found'} pull request #3 https://github.com/${REPO}/pull/3`, 'labelled pull request #3: p1, area:cli', 'check passed: gates (success)']);
  }
  const moved = fakeGitHub({ rounds: [green], openPullSha: 'fff0000older' });
  assert.equal((await mergeRequestOnCi(moved.gh, { labels: ['p1'] }, () => undefined)).kind, 'refused');
  assert.deepEqual(moved.writes, []);
});

test('names each ## section a note lacks of those the repo asks for', () => {
  assert.equal(missingSections('## Reach\nall users\n', ['Reach']), null);
  assert.equal(missingSections('##  Reach  \nall users', ['Reach']), null);
  assert.equal(missingSections(null, []), null);
  assert.equal(missingSections(null, ['Reach', 'Tests']), '## Reach, ## Tests');
  assert.equal(missingSections('Reach: all users\n### Reach\n## Tests', ['Reach']), '## Reach');
});

test('refuses when the pull request head is not the sha that was pushed, before reading any check', async () => {
  const { gh, writes } = fakeGitHub({ rounds: [green], openPullSha: 'fff0000older' });
  const result = await mergeOnCi(gh, fakeMain(), () => undefined);
  assert.deepEqual(result.kind === 'refused' ? result.reason : result, 'the pull request head fff0000 is not dev abc1234: push dev first');
  assert.equal(writes.length, 0);
  assert.ok(!gh.mock.calls.some(call => (call.arguments[0][1] ?? '').includes('actions')));
});

test('never merges on a failed or timed-out check, and says which', async () => {
  const failed = await mergeOnCi(fakeGitHub({ rounds: [[['gates', 'completed', 'failure'], ['test', 'completed', 'success']]] }).gh, fakeMain(), () => undefined);
  assert.deepEqual(failed.kind === 'refused' ? failed.reason : failed, 'failed: gates (failure)');

  const slow = fakeGitHub({ rounds: [[['gates', 'in_progress', null]]] });
  const timedOut = await mergeOnCi(slow.gh, fakeMain(), () => undefined);
  assert.deepEqual(timedOut.kind === 'refused' ? timedOut.reason : timedOut, 'not green after 10 min: gates (in_progress); test (no job or status of that name)');
  assert.ok(!slow.writes.some(args => args[1]?.endsWith('/merge')));
});

const macosUnstarted: JobState = ['test', 'completed', 'cancelled', 'unstarted'];

test('a job GitHub cancelled before any step ran is re-run once, and the merge goes ahead once it passes (T2675)', async () => {
  const { gh, writes } = fakeGitHub({ rounds: [[['gates', 'completed', 'success'], macosUnstarted], [['gates', 'completed', 'success'], ['test', 'queued', null]], green] });
  const log: string[] = [];
  const result = await mergeOnCi(gh, fakeMain(), line => log.push(line));
  assert.equal(result.kind, 'merged');
  assert.deepEqual(writes.filter(args => args[1] === RERUN_PATH), [['api', RERUN_PATH, '-X', 'POST']]);
  assert.ok(log.includes('re-ran run 1: test cancelled before any step ran (no runner came); waiting again, once'), log.join('\n'));
});

test('a second cancel before any step ran refuses, and is never re-run again (T2675)', async () => {
  const { gh, writes } = fakeGitHub({ rounds: [[['gates', 'completed', 'success'], macosUnstarted]] });
  const result = await mergeOnCi(gh, fakeMain(), () => undefined);
  assert.deepEqual(result.kind === 'refused' ? result.reason : result, 'failed: test (cancelled before any step ran, again on attempt 2)');
  assert.equal(writes.filter(args => args[1] === RERUN_PATH).length, 1);
});

test('a job cancelled after a step ran, or a failure beside an unstarted job, refuses without a re-run (T2675)', async () => {
  const started = fakeGitHub({ rounds: [[['gates', 'completed', 'success'], ['test', 'completed', 'cancelled']]] });
  const cancelled = await mergeOnCi(started.gh, fakeMain(), () => undefined);
  assert.deepEqual(cancelled.kind === 'refused' ? cancelled.reason : cancelled, 'failed: test (cancelled)');

  const failing = fakeGitHub({ rounds: [[['gates', 'completed', 'failure'], macosUnstarted]] });
  const failed = await mergeOnCi(failing.gh, fakeMain(), () => undefined);
  assert.deepEqual(failed.kind === 'refused' ? failed.reason : failed, 'failed: gates (failure)');
  assert.ok(![...started.writes, ...failing.writes].some(args => args[1] === RERUN_PATH));
});

test('an unstarted job waits for the rest of the run before its re-run (T2675)', async () => {
  const { gh, writes } = fakeGitHub({ rounds: [[['gates', 'in_progress', null], macosUnstarted], [['gates', 'completed', 'success'], macosUnstarted], green] });
  const waiter = fakeWaiter();
  const result = await waitForChecks(gh, REPO, SHA, HEAD, CHECKS,waiter, POLLING);
  assert.equal(result.verdict, 'passed');
  assert.equal(writes.filter(args => args[1] === RERUN_PATH).length, 1);
  assert.equal(gh.mock.calls.findIndex(call => call.arguments[0][1] === RERUN_PATH) > gh.mock.calls.findIndex(call => (call.arguments[0][1] ?? '').includes('/jobs')), true);
  assert.deepEqual(waiter.slept, [MINUTE, MINUTE]);
});

test('a re-run GitHub refuses fails the unstarted check with its error; one still waiting at the deadline is named (T2675)', async () => {
  const refusing = fakeGitHub({ rounds: [[['gates', 'completed', 'success'], macosUnstarted]], rerun: new Error('gh api repos/Owner/repo/actions/runs/1/rerun-failed-jobs: HTTP 403') });
  const refused = await mergeOnCi(refusing.gh, fakeMain(), () => undefined);
  assert.deepEqual(
    refused.kind === 'refused' ? refused.reason : refused,
    'failed: test (cancelled before any step ran; the re-run failed: gh api repos/Owner/repo/actions/runs/1/rerun-failed-jobs: HTTP 403)',
  );

  // GitHub has not started the new attempt yet: the same run is not re-run twice, and the deadline names it.
  const stuck = fakeGitHub({ rounds: [[['gates', 'completed', 'success'], macosUnstarted]] });
  const sameAttempt: Gh = args => (args[1]?.includes('/actions/runs?head_sha=') === true ? '{"workflow_runs":[{"id":1,"workflow_id":1,"event":"pull_request","run_number":1,"run_attempt":1,"head_branch":"dev"}]}' : stuck.gh(args));
  const result = await waitForChecks(sameAttempt, REPO, SHA, HEAD, CHECKS,fakeWaiter(), { timeoutMs: 2 * MINUTE, intervalMs: MINUTE });
  assert.equal(result.verdict, 'timeout');
  assert.equal(stuck.writes.filter(args => args[1] === RERUN_PATH).length, 1);
  const timedOut = await ciProof(sameAttempt, REPO, HEAD, CHECKS,fakeWaiter(), { timeoutMs: MINUTE, intervalMs: MINUTE }).prove(SHA, () => undefined);
  assert.equal(timedOut, 'not green after 1 min: test (cancelled before any step ran)');
});

test('the summary job failing beside an unstarted leg is re-run with it; failing again on the next attempt refuses (T2675)', async () => {
  const withSummary: RequiredChecks = { names: ['gates', 'test', 'all'], summary: 'all', flaky: [], conditional: [] };
  const echo: readonly JobState[] = [['gates', 'completed', 'success'], macosUnstarted, ['all', 'completed', 'failure']];
  const recovers = fakeGitHub({ rounds: [echo, [...green, ['all', 'completed', 'success']]] });
  const passed = await waitForChecks(recovers.gh, REPO, SHA, HEAD, withSummary,fakeWaiter(), POLLING);
  assert.equal(passed.verdict, 'passed');
  assert.equal(recovers.writes.filter(args => args[1] === RERUN_PATH).length, 1);

  const again = await waitForChecks(fakeGitHub({ rounds: [echo] }).gh, REPO, SHA, HEAD, withSummary,fakeWaiter(), POLLING);
  assert.equal(again.verdict, 'failed');
  assert.deepEqual(again.outcomes.filter(({ state }) => state === 'failed').map(({ name, detail }) => `${name}: ${detail}`), [
    'test: cancelled before any step ran, again on attempt 2',
    'all: failure',
  ]);
});

test('a merge GitHub refuses (not mergeable, head moved) is reported, not thrown', async () => {
  const refused = await mergeOnCi(fakeGitHub({ rounds: [green], merge: new Error('gh api repos/Owner/repo/pulls/3/merge: HTTP 409: Head branch was modified') }).gh, fakeMain(), () => undefined);
  assert.deepEqual(refused.kind === 'refused' ? refused.reason : refused, 'GitHub refused the merge: gh api repos/Owner/repo/pulls/3/merge: HTTP 409: Head branch was modified');
  const unmerged = await mergeOnCi(fakeGitHub({ rounds: [green], merge: '{"merged":false,"message":"Rebase failed"}' }).gh, fakeMain(), () => undefined);
  assert.deepEqual(unmerged.kind === 'refused' ? unmerged.reason : unmerged, 'GitHub refused the merge: Rebase failed');
});

const STALE = 'main moved to moved00, which dev abc1234 does not contain: rebase dev onto origin/main, push it and run merge again';

test('a branch main moved past comes back as moved, with main\'s tip, before opening a pull request or reading a check', async () => {
  const { gh } = fakeGitHub({ rounds: [green] });
  const result = await mergeOnCi(gh, fakeMain({ tips: [MOVED] }), () => undefined);
  assert.deepEqual(result.kind === 'moved' ? [result.pull, result.tip, result.reason] : result, [null, MOVED, STALE]);
  assert.equal(gh.mock.callCount(), 0);
});

test('a main that moves while the checks run comes back as moved, without merging', async () => {
  const { gh, writes } = fakeGitHub({ rounds: [green] });
  const main = fakeMain({ tips: [BASE, MOVED] });
  const result = await mergeOnCi(gh, main, () => undefined);
  assert.deepEqual(result.kind === 'moved' ? [result.pull?.number, result.tip, result.reason] : result, [3, MOVED, STALE]);
  assert.ok(!writes.some(args => args[1]?.endsWith('/merge')));
  assert.deepEqual(main.reads, [BASE, MOVED]);
});

test("GitHub's 405 for a base branch modified as it merged reads main and comes back as moved (T2696)", async () => {
  const merge = new Error('gh api repos/Owner/repo/pulls/3/merge: HTTP 405: Base branch was modified. Review and try the merge again.');
  const main = fakeMain({ tips: [BASE, BASE, MOVED] });
  const result = await mergeOnCi(fakeGitHub({ rounds: [green], merge }).gh, main, () => undefined);
  assert.deepEqual(result.kind === 'moved' ? [result.pull?.number, result.tip, result.reason] : result, [3, MOVED, STALE]);
  assert.deepEqual(main.reads, [BASE, BASE, MOVED]);

  const still = await mergeOnCi(fakeGitHub({ rounds: [green], merge }).gh, fakeMain(), () => undefined);
  assert.equal(still.kind === 'refused' ? still.reason : still, `GitHub refused the merge: ${merge.message}`, 'a 405 with main still in the head stays a refusal');
});

test('reads main before opening, again right before merging, and once more to confirm the merged tree is the checked one', async () => {
  const main = fakeMain();
  const result = await mergeOnCi(fakeGitHub({ rounds: [green] }).gh, main, () => undefined);
  assert.equal(result.kind, 'merged');
  assert.equal(main.reads.length, 3);
});

test('reports a merge onto a main that moved after the last read as drifted, and one whose tree it could not compare as unchecked', async () => {
  const drifted = await mergeOnCi(fakeGitHub({ rounds: [green] }).gh, fakeMain({ mergedTree: 'tree-other' }), () => undefined);
  assert.deepEqual(drifted.kind === 'drifted' ? [drifted.pull.number, drifted.sha, drifted.reason] : drifted, [
    3,
    'main999',
    'main moved just before the merge: main999 is not the tree the checks passed on abc1234; check it (a plugin version bump may be lost) and ship a fix',
  ]);
  for (const [treeError, detail] of [[new Error('fatal: bad object main999'), 'fatal: bad object main999'], ['git exited 128', 'git exited 128']] as const) {
    const unknown = await mergeOnCi(fakeGitHub({ rounds: [green] }).gh, fakeMain({ treeError }), () => undefined);
    assert.deepEqual(unknown.kind === 'unchecked' ? [unknown.sha, unknown.reason] : unknown, ['main999', `could not compare main999 with the checked abc1234: ${detail}`]);
  }
});

const LANDED = 'landed0ccc';
const BAD_GATEWAY = new Error('gh api repos/Owner/repo/pulls/3/merge: HTTP 502: Server Error');
const mergeWrites = (writes: readonly string[][]): number => writes.filter(args => args[1] === `repos/${REPO}/pulls/3/merge`).length;

test('a merge call GitHub answers with a 502 after main took the rebase is merged, not refused (T2709)', async () => {
  const { gh, writes } = fakeGitHub({ rounds: [green], merge: BAD_GATEWAY });
  const main = fakeMain({ tips: [BASE, BASE, LANDED] });
  const log: string[] = [];
  const result = await mergeOnCi(gh, main, line => log.push(line));
  assert.deepEqual(result.kind === 'merged' ? [result.pull.number, result.sha] : result, [3, LANDED]);
  assert.equal(mergeWrites(writes), 1, 'a landed merge is never called again');
  assert.ok(log.includes(`the merge call failed (${BAD_GATEWAY.message}), but main moved to landed0 holding the checked tree: #3 merged; GitHub may show it open until its head is deleted`), log.join('\n'));
});

test('a merge call with no answer and main unchanged goes once more, still pinned to the checked head (T2709)', async () => {
  const { gh, writes } = fakeGitHub({ rounds: [green], merges: [BAD_GATEWAY, '{"sha":"main999","merged":true,"message":"merged"}'] });
  const log: string[] = [];
  const result = await mergeOnCi(gh, fakeMain(), line => log.push(line));
  assert.deepEqual(result.kind === 'merged' ? result.sha : result, 'main999');
  assert.deepEqual(writes.filter(args => args[1] === `repos/${REPO}/pulls/3/merge`), [0, 1].map(() => ['api', `repos/${REPO}/pulls/3/merge`, '-X', 'PUT', '-f', 'merge_method=rebase', '-f', `sha=${SHA}`]));
  assert.ok(log.includes(`the merge call failed (${BAD_GATEWAY.message}) and main does not hold the checked tree: trying once more`), log.join('\n'));
});

test('a second call failing because the first landed late is merged; a main that moved elsewhere comes back as moved (T2709)', async () => {
  const baseModified = new Error('gh api repos/Owner/repo/pulls/3/merge: HTTP 405: Base branch was modified. Review and try the merge again.');
  const late = await mergeOnCi(fakeGitHub({ rounds: [green], merges: [BAD_GATEWAY, baseModified] }).gh, fakeMain({ tips: [BASE, BASE, BASE, LANDED] }), () => undefined);
  assert.deepEqual(late.kind === 'merged' ? late.sha : late, LANDED);

  const elsewhere = await mergeOnCi(fakeGitHub({ rounds: [green], merges: [BAD_GATEWAY, baseModified] }).gh, fakeMain({ tips: [BASE, BASE, MOVED], mergedTree: 'tree-other' }), () => undefined);
  assert.deepEqual(elsewhere.kind === 'moved' ? [elsewhere.tip, elsewhere.reason] : elsewhere, [MOVED, STALE]);
});

test('two merge calls with no answer and main never holding the checked tree refuse, naming both and what to check (T2709)', async () => {
  const reset = new Error('gh api repos/Owner/repo/pulls/3/merge: connection reset by peer');
  const { gh, writes } = fakeGitHub({ rounds: [green], merges: [BAD_GATEWAY, reset] });
  const result = await mergeOnCi(gh, fakeMain(), () => undefined);
  assert.deepEqual(
    result.kind === 'refused' ? result.reason : result,
    `GitHub refused the merge: ${BAD_GATEWAY.message}; again: ${reset.message}; main does not hold the checked tree, so check #3 on GitHub before shipping again`,
  );
  assert.equal(mergeWrites(writes), 2, 'never a third call');

  const log: string[] = [];
  const unread = await mergeOnCi(fakeGitHub({ rounds: [green], merge: BAD_GATEWAY }).gh, fakeMain({ tips: [BASE, BASE, LANDED], treeError: 'git exited 128' }), line => log.push(line));
  assert.equal(unread.kind, 'refused');
  assert.equal(log.filter(line => line === 'could not read main after the merge call: git exited 128').length, 2);
});

test("a merge GitHub refuses with a 4xx is not read back from main nor called again (T2709)", async () => {
  const main = fakeMain();
  const { gh, writes } = fakeGitHub({ rounds: [green], merge: new Error('gh api repos/Owner/repo/pulls/3/merge: HTTP 409: Head branch was modified') });
  assert.equal((await mergeOnCi(gh, main, () => undefined)).kind, 'refused');
  assert.equal(mergeWrites(writes), 1);
  assert.deepEqual(main.reads, [BASE, BASE]);
});

test("reads main through git in the repo dir: a fetch then origin's tip, containment by merge-base, a commit's tree", () => {
  const calls: string[] = [];
  const answers: Record<string, string> = {
    'fetch --quiet origin trunk': '',
    'rev-parse refs/remotes/origin/trunk': BASE,
    [`merge-base ${SHA} ${BASE}`]: BASE,
    [`merge-base ${SHA} ${MOVED}`]: BASE,
    [`rev-parse ${SHA}^{tree}`]: 'tree-checked',
  };
  const main = mainBranchOf((...args) => {
    const key = args.join(' ');
    calls.push(key);
    return answers[key] ?? assert.fail(`unexpected git ${key}`);
  }, 'trunk');
  assert.equal(main.tip(), BASE);
  assert.deepEqual(calls, ['fetch --quiet origin trunk', 'rev-parse refs/remotes/origin/trunk']);
  assert.equal(main.contains(SHA, BASE), true);
  assert.equal(main.contains(SHA, MOVED), false);
  assert.equal(main.treeOf(SHA), 'tree-checked');
});

test("fetches main once more when the fetch lost a ref-store race with another fetch, and only then (#1452)", () => {
  const fetchesFailing = (errors: readonly string[]): { main: MainBranch; calls: string[] } => {
    const calls: string[] = [];
    let failed = 0;
    const main = mainBranchOf((...args) => {
      const key = args.join(' ');
      calls.push(key);
      if (key === 'fetch --quiet origin trunk') {
        if (failed < errors.length) throw new Error(errors[failed++]);
        return '';
      }
      return key === 'rev-parse refs/remotes/origin/trunk' ? BASE : assert.fail(`unexpected git ${key}`);
    }, 'trunk');
    return { main, calls };
  };
  const raced = fetchesFailing([REF_RACE]);
  assert.equal(raced.main.tip(), BASE);
  assert.deepEqual(raced.calls, ['fetch --quiet origin trunk', 'fetch --quiet origin trunk', 'rev-parse refs/remotes/origin/trunk']);

  const twice = fetchesFailing([REF_RACE, REF_RACE]);
  assert.throws(() => twice.main.tip(), /incorrect old value provided/);
  assert.equal(twice.calls.length, 2, 'one retry, no more');

  const offline = fetchesFailing(['Command failed: git fetch --quiet origin trunk\nfatal: unable to access the remote']);
  assert.throws(() => offline.main.tip(), /unable to access/);
  assert.equal(offline.calls.length, 1, 'any other fetch failure is not retried');
});

test('reads the repo dir and the polling flags', () => {
  assert.deepEqual(parseArgs(['C:/repo']), { dir: 'C:/repo', head: null, timeoutMin: 45, intervalS: 30, noteFile: null, approved: null, release: null });
  assert.deepEqual(parseArgs(['C:/repo', '--head', 'feature/x', '--timeout-min', '5', '--interval-s', '10']), { dir: 'C:/repo', head: 'feature/x', timeoutMin: 5, intervalS: 10, noteFile: null, approved: null, release: null });
  assert.equal(parseArgs(['C:/repo', '--approved', 'abc1234def']).approved, 'abc1234def');
  assert.throws(() => parseArgs(['C:/repo', '--approved', 'HEAD']), /usage: ship\.ts merge/);
  assert.throws(() => parseArgs([]), /usage: ship\.ts merge/);
  assert.throws(() => parseArgs(['--head', 'dev']), /usage: ship\.ts merge/);
  assert.throws(() => parseArgs(['C:/repo', '--timeout-min', '0']), /usage: ship\.ts merge/);
  assert.throws(() => parseArgs(['C:/repo', '--head', 'a b']), /usage: ship\.ts merge/);
  assert.throws(() => parseArgs(['C:/repo', '--interval-s']), /--interval-s needs a value/);
});

interface RunFixture {
  remote?: string;
  /** What `rev-parse --abbrev-ref HEAD` prints in the repo dir: a branch, or HEAD when detached. */
  checkedOut?: string;
  pushedSha?: string;
  subjects?: string;
  credential?: Credential;
  rounds?: readonly (readonly JobState[])[];
  /** main's sha on origin (BASE unless given) and the tree of the commit GitHub merges as (SHA's unless given). */
  mainTip?: string;
  mergedTree?: string;
  /** Merge on the `local` gate: what the repo dir has checked out, its changes, a stored pass record and the check's exit. */
  local?: { checkedOut?: string; status?: string; record?: string; exit?: number };
  /** What the renamed-callers gate refuses with; null (the default) lets the merge go on. */
  renamedCallers?: string;
  /** What the merge's clearance finds (T2788); the lead's approval by default. */
  clearance?: MergeClearance;
  /** What catching up a head main moved past answers, in turn (the last repeats); CAUGHT_UP_REFUSED unless given. */
  catchUp?: readonly CatchUp[];
  /** Whether REBASED still misses main's tip, as when main moved again during its checks. */
  rebasedBehind?: boolean;
  /** Whether the step's host share is set aside (yes unless given), and why taking it back fails (it never does unless given). */
  away?: boolean;
  lostShare?: string;
  /** Whether main, at BASE when the merge starts, moves to MOVED while the first head's checks run (mainTip unset). */
  movesDuringWait?: boolean;
  /** The work commits each head carries over main (approval.ts `workCommitsOf`); SHA and REBASED the same two unless given. */
  work?: Readonly<Record<string, readonly WorkCommit[]>>;
  /** How many of main's fetches after the merge call fail on a ref-store race with another fetch (#1452); none unless given. */
  racedFetches?: number;
  /**
   * The repo's release pull request (T4645), on RELEASE at SHA as origin has it: whether it is open (yes unless given)
   * and why the release check refuses its head (it never does unless given). Unset, repos.json lists none.
   */
  release?: { open?: boolean; refusal?: string };
  /** Whether main merges through GitHub's merge queue (T3386): its pull request is out of the queue, then merged at QUEUED. */
  queue?: boolean;
  /** The register's task of the branch (T4796): TASK unless given; null for none. */
  task?: PullTask | null;
  /** The labels the repo has (T4796); none unless given, so no label is added. */
  repoLabels?: readonly string[];
}

/** The queue's merge commit of the pull request, which main on origin holds once it landed. */
const QUEUED = 'queued0eee';

/** GitHub's merge queue in front of `rest`: the graphql reads and the enqueue go to it, every other call to `rest`. */
function withMergeQueue(rest: Gh, enqueued: string[][]): Gh {
  let reads = 0;
  return args => {
    if (args[1] !== 'graphql') return rest(args);
    if (args.some(arg => arg.startsWith('query=mutation'))) {
      enqueued.push([...args]);
      return JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { state: 'QUEUED', position: 1 } } } });
    }
    const merged = reads++ > 0;
    return JSON.stringify({
      data: { repository: { pullRequest: { id: 'PR_node3', headRefOid: SHA, merged, mergeCommit: merged ? { oid: QUEUED } : null, mergeQueueEntry: null, timelineItems: { nodes: [] } } } },
    });
  };
}

/** The branch the release tool keeps the release pull request on (T4645). */
const RELEASE = 'release-please--branches--main';

/** The head a catch-up pushes: BRANCH rebased onto MOVED. */
const NEXT = 't9-change-2';
const REBASED = 'rebased0ccc';
const CAUGHT_UP: CatchUp = { kind: 'rebased', head: NEXT, sha: REBASED };
const CAUGHT_UP_REFUSED: CatchUp = { kind: 'refused', reason: 'main moved to moved00, which t9-change abc1234 does not contain, and rebasing it onto that tip conflicts' };

/** The approved head's two work commits, and the same patches as REBASED carries them. */
const APPROVED_WORK: readonly WorkCommit[] = [
  { sha: 'aaaa1111aaaa', subject: 'cli: a', merge: false, patch: 'patch-a' },
  { sha: 'bbbb2222bbbb', subject: 'docs: b', merge: false, patch: 'patch-b' },
];
const REBASED_WORK: readonly WorkCommit[] = [
  { sha: 'cccc3333cccc', subject: 'cli: a', merge: false, patch: 'patch-a' },
  { sha: 'dddd4444dddd', subject: 'docs: b', merge: false, patch: 'patch-b' },
];

/** The git folder as git names it for a linked worktree: absolute on every OS ('C:/repo/.git' is relative on POSIX). */
const GIT_DIR = resolve('/repo/.git');
const RECORD_PATH = join(GIT_DIR, 'local-ci', 'tree-checked.json').replaceAll('\\', '/');
const LOCAL_PROFILE = '"local":{"runner":"tools/ci/local.ts"}';
const RUNNER = 'runner tools/ci/local.ts';

interface FakeGate {
  gate: GateDeps;
  runs: string[];
  written: string[];
}

function fakeGate(local: NonNullable<RunFixture['local']>, log: (line: string) => void): FakeGate {
  const runs: string[] = [];
  const written: string[] = [];
  const answers: Record<string, string> = {
    'rev-parse HEAD': local.checkedOut ?? SHA,
    'status --porcelain': local.status ?? '',
    'rev-parse HEAD^{tree}': 'tree-checked',
    'rev-parse --git-common-dir': GIT_DIR,
  };
  const gate: GateDeps = {
    git: (...args) => {
      const answer = answers[args.join(' ')];
      if (answer === undefined) throw new Error(`unexpected gate git ${args.join(' ')}`);
      return answer;
    },
    exists: path => path.replaceAll('\\', '/') === 'C:/repo/tools/ci/local.ts',
    readText: path => (path.replaceAll('\\', '/') === RECORD_PATH ? (local.record ?? null) : null),
    writeText: (path, text) => written.push(`${path.replaceAll('\\', '/')} ${text}`),
    run: check => {
      runs.push(check.name);
      return { status: local.exit ?? 0, output: 'lint: 1 problem', ms: 2000 };
    },
    now: () => new Date('2026-10-15T10:00:00Z'),
    log,
  };
  return { gate, runs, written };
}

const BRANCH = 't9-change';

/** How git fails a fetch while another worktree of the repo updates the same remote ref (#1452). */
const REF_RACE = 'Command failed: git fetch --quiet origin main\nerror: fetching ref refs/remotes/origin/main failed: incorrect old value provided';

function runFixture(fixture: RunFixture = {}): {
  deps: MergeDeps;
  gitCalls: string[];
  out: string[];
  err: string[];
  ghFor: ReturnType<typeof mock.fn<(token: string) => Gh>>;
  ghWrites: string[][];
  local: FakeGate;
  renamedCallers: ReturnType<typeof mock.fn<MergeDeps['renamedCallers']>>;
  sweep: ReturnType<typeof mock.fn<MergeDeps['sweep']>>;
  clearMerge: ReturnType<typeof mock.fn<MergeDeps['clearMerge']>>;
  clearTaskMerge: ReturnType<typeof mock.fn<MergeDeps['clearTaskMerge']>>;
  releaseRefusal: ReturnType<typeof mock.fn<MergeDeps['releaseRefusal']>>;
  catchUp: ReturnType<typeof mock.fn<MergeDeps['catchUp']>>;
  /** Each step-away and step-back of the step's host share, in turn, with the catch-ups run before it. */
  shareCalls: string[];
  /** Each enqueue call to GitHub's merge queue (fixture `queue`). */
  enqueued: string[][];
} {
  const gitCalls: string[] = [];
  const shareCalls: string[] = [];
  const answers: Record<string, string> = {
    'remote get-url origin': fixture.remote ?? `git@github.com:${REPO}.git`,
    'rev-parse --abbrev-ref HEAD': fixture.checkedOut ?? BRANCH,
    [`fetch --quiet origin ${BRANCH} main`]: '',
    [`rev-parse refs/heads/${BRANCH}`]: SHA,
    [`rev-parse refs/remotes/origin/${BRANCH}`]: fixture.pushedSha ?? SHA,
    [`log --reverse --format=%s refs/remotes/origin/main..${SHA}`]: fixture.subjects ?? 'cli: a\ndocs: b',
    'fetch --quiet origin main': '',
    'rev-parse refs/remotes/origin/main': fixture.mainTip ?? BASE,
    [`merge-base ${SHA} ${BASE}`]: BASE,
    [`merge-base ${SHA} ${MOVED}`]: BASE,
    [`rev-parse ${SHA}^{tree}`]: 'tree-checked',
    'rev-parse main999^{tree}': fixture.mergedTree ?? 'tree-checked',
    [`fetch --quiet origin ${NEXT} main`]: '',
    [`rev-parse refs/heads/${NEXT}`]: REBASED,
    [`rev-parse refs/remotes/origin/${NEXT}`]: REBASED,
    [`log --reverse --format=%s refs/remotes/origin/main..${REBASED}`]: fixture.subjects ?? 'cli: a\ndocs: b',
    [`merge-base ${REBASED} ${MOVED}`]: fixture.rebasedBehind === true ? BASE : MOVED,
    [`rev-parse ${REBASED}^{tree}`]: 'tree-checked',
    'rev-parse --verify --quiet abc1234^{commit}': SHA,
    [`fetch --quiet origin ${RELEASE} main`]: '',
    [`rev-parse refs/remotes/origin/${RELEASE}`]: SHA,
    [`merge-base ${BASE} ${QUEUED}`]: QUEUED,
  };
  const out: string[] = [];
  const err: string[] = [];
  // Main at MOVED reaches GitHub only through a caught-up head: NEXT at REBASED is the pull request's and the run's.
  const caughtUpHead = fixture.mainTip === MOVED;
  // A main that moves during the wait sees the first head's pull request opened, then the caught-up one's.
  const heads: readonly PushedHead[] | undefined = fixture.movesDuringWait === true ? [{ sha: SHA, branch: BRANCH }, { sha: REBASED, branch: NEXT }] : undefined;
  // The release tool opened the release pull request at SHA, and CI ran on its branch.
  const releasePull = fixture.release === undefined ? {} : { openPullSha: fixture.release.open === false ? null : SHA, branch: RELEASE };
  const { gh, writes } = fakeGitHub({ rounds: fixture.rounds ?? [green], openedSha: caughtUpHead ? REBASED : SHA, branch: caughtUpHead ? NEXT : BRANCH, ...(heads === undefined ? {} : { heads }), ...releasePull, ...(fixture.repoLabels === undefined ? {} : { repoLabels: fixture.repoLabels }) });
  let mainReads = 0;
  let mainFetches = 0;
  let raced = fixture.racedFetches ?? 0;
  const local = fakeGate(fixture.local ?? {}, line => out.push(line));
  const enqueued: string[][] = [];
  const github = fixture.queue === true ? withMergeQueue(gh, enqueued) : gh;
  const ghFor = mock.fn((_token: string): Gh => github);
  const renamedCallers = mock.fn((_base: string, _tip: string, _repo: string): string | null => fixture.renamedCallers ?? null);
  const sweep = mock.fn<MergeDeps['sweep']>(() => undefined);
  const clearMerge = mock.fn<MergeDeps['clearMerge']>(() => Promise.resolve(fixture.clearance ?? { kind: 'approved', by: 'lead' }));
  const clearTaskMerge = mock.fn<MergeDeps['clearTaskMerge']>(() => Promise.resolve(fixture.clearance ?? { kind: 'approved', by: 'lead' }));
  const pullTask = mock.fn<MergeDeps['pullTask']>(() => Promise.resolve(fixture.task === null ? undefined : (fixture.task ?? TASK)));
  const releaseRefusal = mock.fn<MergeDeps['releaseRefusal']>(() => fixture.release?.refusal ?? null);
  const releaseProfile = fixture.release === undefined ? '' : `,"release":{"head":"${RELEASE}","changelog":"CHANGELOG.md"}`;
  const answersOfCatchUp = fixture.catchUp ?? [CAUGHT_UP_REFUSED];
  let caughtUp = 0;
  const catchUp = mock.fn<MergeDeps['catchUp']>(() => answersOfCatchUp[Math.min(caughtUp++, answersOfCatchUp.length - 1)] ?? CAUGHT_UP_REFUSED);
  const deps: MergeDeps = {
    git: (...args) => {
      const key = args.join(' ');
      gitCalls.push(key);
      if (fixture.movesDuringWait === true && key === 'rev-parse refs/remotes/origin/main') return mainReads++ === 0 ? BASE : MOVED;
      if (key === 'fetch --quiet origin main' && ++mainFetches >= 3 && raced > 0) {
        raced -= 1;
        throw new Error(REF_RACE);
      }
      const answer = answers[key];
      if (answer === undefined) throw new Error(`unexpected git ${key}`);
      return answer;
    },
    profiles: parseProfiles(`{"${REPO}":{"main":"main","gate":"${fixture.local === undefined ? 'ci' : 'local'}","checks":["gates","test"],"regenerated":["out/"],${LOCAL_PROFILE}${releaseProfile}${fixture.queue === true ? ',"queue":true' : ''}}}`),
    credential: () => fixture.credential ?? { kind: 'found', secret: GH_SECRET },
    ghFor,
    waiter: fakeWaiter(),
    gate: local.gate,
    renamedCallers,
    sweep,
    clearMerge,
    clearTaskMerge,
    pullTask,
    releaseRefusal,
    catchUp,
    workOf: (rev) => (fixture.work ?? { [SHA]: APPROVED_WORK, [REBASED]: REBASED_WORK })[rev] ?? [],
    share: {
      away: () => {
        shareCalls.push(`away after ${catchUp.mock.callCount()} catch-up(s)`);
        return Promise.resolve(fixture.away ?? true);
      },
      back: () => {
        shareCalls.push(`back after ${catchUp.mock.callCount()} catch-up(s)`);
        return Promise.resolve(fixture.lostShare ?? null);
      },
    },
    // The turn's wait goes into the git calls, so a spec sees where it falls among main's reads.
    turn: {
      wait: () => {
        gitCalls.push('turn wait');
        return Promise.resolve();
      },
      beat: () => undefined,
      end: () => undefined,
    },
    out: line => out.push(line),
    err: line => err.push(line),
  };
  return { deps, gitCalls, out, err, ghFor, ghWrites: writes, local, renamedCallers, sweep, clearMerge, clearTaskMerge, pullTask, releaseRefusal, catchUp, shareCalls, enqueued };
}

const ARGS: MergeArgs = { dir: 'C:/repo', head: BRANCH, timeoutMin: 10, intervalS: 60, noteFile: null, approved: null, release: null };
/** What `ship.ts merge` says once the lead's approval cleared the head (T2788). */
const APPROVED_LINE = `merge of ${BRANCH} abc1234de: approved by lead`;

test('clears the pushed head on the approval --approved names, saying who approved it (T2788)', async () => {
  const { deps, out, clearMerge } = runFixture();
  assert.equal(await runMerge({ ...ARGS, approved: 'abc1234' }, deps), 0);
  assert.deepEqual(clearMerge.mock.calls.map(call => call.arguments), [[BRANCH, SHA, 'abc1234']]);
  assert.equal(out[0], APPROVED_LINE);
});

test("a root team's lead clears its own merge and says so", async () => {
  const { deps, out } = runFixture({ clearance: { kind: 'self' } });
  assert.equal(await runMerge(ARGS, deps), 0);
  assert.equal(out[0], `merge of ${BRANCH} abc1234de: the caller's own, a root team's lead`);
});

test('a merge without the approval of its head is refused before the token is read or any GitHub call', async () => {
  let tokenReads = 0;
  const { deps, out, err, ghFor, renamedCallers } = runFixture({ clearance: { kind: 'refused', reason: 'T9 has no approval of abc1234de by lead' } });
  const counted: MergeDeps = {
    ...deps,
    credential: () => {
      tokenReads += 1;
      return deps.credential();
    },
  };
  assert.equal(await runMerge(ARGS, counted), 1);
  assert.deepEqual([out, err], [[], ['REFUSED T9 has no approval of abc1234de by lead']]);
  assert.equal(tokenReads, 0);
  assert.equal(renamedCallers.mock.callCount(), 0);
  assert.equal(ghFor.mock.callCount(), 0);
});

test("a ship's own merge asks no clearance: the ship cleared its head before it pushed", async () => {
  const { deps, out, clearMerge } = runFixture({ clearance: { kind: 'refused', reason: 'never asked' } });
  assert.deepEqual(await mergeBranch(['C:/repo', '--head', BRANCH], () => deps), { kind: 'done', code: 0 });
  assert.equal(clearMerge.mock.callCount(), 0);
  assert.equal(out.at(-1), 'MERGED #3 into main, now at main999');
});

test('merges the pushed head of a repo found from its origin remote, with the token from the keychain', async () => {
  const { deps, gitCalls, out, err, ghFor } = runFixture();
  assert.equal(await runMerge(ARGS, deps), 0);
  assert.deepEqual(err, []);
  assert.equal(out.at(-1), 'MERGED #3 into main, now at main999');
  assert.equal(ghFor.mock.calls[0]?.arguments[0], GH_SECRET);
  assert.equal(gitCalls[1], `fetch --quiet origin ${BRANCH} main`);
  assert.ok(!gitCalls.includes('rev-parse --abbrev-ref HEAD'), 'an explicit --head is not second-guessed');
});

test("on a merge queue repo, a head whose checks passed is enqueued at its sha with no landing turn and no merge call, and lands at the queue's commit (T3386)", async () => {
  const { deps, gitCalls, out, err, ghWrites, enqueued, sweep } = runFixture({ queue: true });
  assert.equal(await runMerge(ARGS, deps), 0);
  assert.deepEqual(err, []);
  assert.equal(enqueued.length, 1);
  assert.ok(enqueued[0]?.includes(`head=${SHA}`), 'the queue takes the checked head only');
  assert.ok(!gitCalls.includes('turn wait'), 'the queue orders the landings, so no landing turn is waited for');
  assert.deepEqual(ghWrites.filter(write => write.some(arg => arg.endsWith('/merge'))), []);
  assert.ok(out.includes(`enqueued #3 at ${SHA.slice(0, 7)} in the merge queue`));
  assert.equal(out.at(-1), `MERGED #3 into main, now at ${QUEUED.slice(0, 7)}`);
  assert.equal(sweep.mock.callCount(), 1);
});

test('without the merge queue, a head whose checks passed waits for its landing turn and merges through the merge call', async () => {
  const { deps, gitCalls, ghWrites, enqueued } = runFixture();
  assert.equal(await runMerge(ARGS, deps), 0);
  assert.ok(gitCalls.includes('turn wait'));
  assert.deepEqual(enqueued, []);
  assert.equal(ghWrites.filter(write => write.some(arg => arg.endsWith('/merge'))).length, 1);
});

test('without --head it merges the branch checked out in the repo dir', async () => {
  const { deps, gitCalls, out } = runFixture();
  assert.equal(await runMerge({ ...ARGS, head: null }, deps), 0);
  assert.deepEqual(gitCalls.slice(1, 3), ['rev-parse --abbrev-ref HEAD', `fetch --quiet origin ${BRANCH} main`]);
  assert.equal(out.at(-1), 'MERGED #3 into main, now at main999');
});

test('refuses a head that is not pushed, an empty range or a repo with no profile, before any GitHub call', async () => {
  for (const [fixture, message] of [
    [{ pushedSha: 'other' }, new RegExp(`${BRANCH} abc1234 is not pushed: push it first`)],
    [{ subjects: '' }, new RegExp(`${BRANCH} has nothing that main lacks`)],
    [{ remote: 'git@github.com:Owner/unknown.git' }, /no check list for Owner\/unknown/],
  ] as const) {
    const { deps, ghFor } = runFixture(fixture);
    await assert.rejects(runMerge(ARGS, deps), message);
    assert.equal(ghFor.mock.callCount(), 0);
  }
});

test('refuses main itself or a detached HEAD as the head, before any fetch or GitHub call', async () => {
  for (const [args, fixture, message] of [
    [{ ...ARGS, head: 'main' }, {}, /main is the branch merged into: ship a change branch/],
    [{ ...ARGS, head: null }, { checkedOut: 'main' }, /main is the branch merged into: ship a change branch/],
    [{ ...ARGS, head: null }, { checkedOut: 'HEAD' }, /detached HEAD: pass --head <branch>/],
  ] as const) {
    const { deps, gitCalls, ghFor } = runFixture(fixture);
    await assert.rejects(runMerge(args, deps), message);
    assert.ok(!gitCalls.some(call => call.startsWith('fetch')));
    assert.equal(ghFor.mock.callCount(), 0);
  }
});

test('asks the renamed-callers gate about main as fetched and the pushed head of the repo merged', async () => {
  const { deps, renamedCallers } = runFixture();
  assert.equal(await runMerge(ARGS, deps), 0);
  assert.deepEqual(
    renamedCallers.mock.calls.map(call => call.arguments),
    [['refs/remotes/origin/main', SHA, REPO]],
  );
});

test('a renamed command a consumer still calls is refused before the token is read or any GitHub call', async () => {
  const refusal = 'this change renames teamrig heavy to queue while 1 consumer file(s) still call only the old name: move them (or name both) and merge again\n  C:/api/.husky/run-checks.sh:4 teamrig heavy -> queue';
  let tokenReads = 0;
  const { deps, out, err, ghFor } = runFixture({ renamedCallers: refusal });
  const counted: MergeDeps = {
    ...deps,
    credential: () => {
      tokenReads += 1;
      return deps.credential();
    },
  };
  assert.equal(await runMerge(ARGS, counted), 1);
  assert.deepEqual(err, [`REFUSED ${refusal}`]);
  assert.deepEqual(out, [APPROVED_LINE]);
  assert.equal(tokenReads, 0);
  assert.equal(ghFor.mock.callCount(), 0);
});

test('without a stored token it says how to store one and makes no GitHub call', async () => {
  const { deps, err, ghFor } = runFixture({ credential: { kind: 'missing' } });
  assert.equal(await runMerge(ARGS, deps), 1);
  assert.match(err[0] ?? '', /teamrig-ship-gh: not stored/);
  assert.equal(ghFor.mock.callCount(), 0);
});

test('a refused merge exits 1 with the reason', async () => {
  const { deps, err } = runFixture({ rounds: [[['gates', 'completed', 'cancelled'], ['test', 'completed', 'success']]] });
  assert.equal(await runMerge(ARGS, deps), 1);
  assert.deepEqual(err, ['REFUSED failed: gates (cancelled)']);
});

test('a branch main moved past that cannot catch up is refused before any pull request; a merge onto a moved main exits 1 after MERGED', async () => {
  const stale = runFixture({ mainTip: MOVED });
  assert.equal(await runMerge(ARGS, stale.deps), 1);
  assert.deepEqual(stale.err, [`REFUSED ${CAUGHT_UP_REFUSED.kind === 'refused' ? CAUGHT_UP_REFUSED.reason : ''}`]);
  assert.deepEqual(stale.out, [APPROVED_LINE]);
  assert.equal(stale.ghWrites.length, 0);

  const drifted = runFixture({ mergedTree: 'tree-other' });
  assert.equal(await runMerge(ARGS, drifted.deps), 1);
  assert.equal(drifted.out.at(-1), 'MERGED #3 into main, now at main999');
  assert.match(drifted.err[0] ?? '', /^DRIFTED main moved just before the merge: main999 is not the tree the checks passed on abc1234/);
});

test('a drift check whose fetch lost a race keeps the merge a success: retried once it compares, else it says it could not run (#1452)', async () => {
  const once = runFixture({ racedFetches: 1 });
  assert.equal(await runMerge(ARGS, once.deps), 0);
  assert.equal(once.out.at(-1), 'MERGED #3 into main, now at main999');
  assert.deepEqual(once.err, []);

  const twice = runFixture({ racedFetches: 2 });
  assert.equal(await runMerge(ARGS, twice.deps), 0);
  assert.equal(twice.out.at(-1), 'MERGED #3 into main, now at main999');
  assert.deepEqual(twice.err, [
    `UNCHECKED the drift check could not run: could not compare main999 with the checked abc1234: ${REF_RACE}; check by hand that main999 holds the tree the checks passed on`,
  ]);
  assert.equal(twice.sweep.mock.callCount(), 1, 'a landed merge sweeps its head as usual');
});

test('a head main moved past while the merge waited is caught up as a new branch and that branch merges (T2809)', async () => {
  const { deps, out, err, catchUp, sweep, gitCalls } = runFixture({ mainTip: MOVED, catchUp: [CAUGHT_UP] });
  assert.equal(await runMerge(ARGS, deps), 0);
  assert.deepEqual(err, []);
  assert.deepEqual(
    catchUp.mock.calls.map(call => call.arguments[0]),
    [{ head: BRANCH, stem: BRANCH, tip: MOVED, main: 'main', regenerated: ['out/'] }],
  );
  assert.ok(gitCalls.includes(`fetch --quiet origin ${NEXT} main`), 'the second run reads the new head as pushed');
  assert.equal(out.at(-1), 'MERGED #3 into main, now at main999');
  assert.deepEqual(sweep.mock.calls.map(call => call.arguments[0]), [{ repo: REPO, head: NEXT, sha: REBASED }]);
});

test('a caught-up head merges on the approval of the head it was caught up from, asking no clearance of its own (T2809)', async () => {
  const { deps, out, err, clearMerge } = runFixture({ mainTip: MOVED, catchUp: [CAUGHT_UP] });
  assert.equal(await runMerge({ ...ARGS, approved: 'abc1234' }, deps), 0);
  assert.deepEqual(err, []);
  assert.deepEqual(clearMerge.mock.calls.map(call => call.arguments), [[BRANCH, SHA, 'abc1234']]);
  assert.deepEqual(out.slice(0, 2), [APPROVED_LINE, `merge of ${NEXT} rebased0c: caught up from ${BRANCH} abc1234de, approved by lead`]);
});

test('a merge run again on the head its catch-up pushed, after GitHub failed the merge call, clears on the approval of the head it was caught up from (#1450)', async () => {
  const { deps, out, err, clearMerge, catchUp } = runFixture({ mainTip: MOVED });
  assert.equal(await runMerge({ ...ARGS, head: NEXT, approved: 'abc1234' }, deps), 0, err.join('\n'));
  assert.deepEqual(clearMerge.mock.calls.map(call => call.arguments), [[NEXT, SHA, 'abc1234']]);
  assert.equal(out[0], `merge of ${NEXT} rebased0c: carries the approved abc1234de's 2 work commit(s), patch for patch, approved by lead`);
  assert.equal(out.at(-1), 'MERGED #3 into main, now at main999');
  assert.equal(catchUp.mock.callCount(), 0);
});

test('a commit added on top of the head a catch-up pushed is refused before any clearance or GitHub call (#1450)', async () => {
  const extra: WorkCommit = { sha: 'eeee5555eeee', subject: 'cli: c', merge: false, patch: 'patch-c' };
  const { deps, err, clearMerge, ghFor } = runFixture({ mainTip: MOVED, work: { [SHA]: APPROVED_WORK, [REBASED]: [...REBASED_WORK, extra] } });
  assert.equal(await runMerge({ ...ARGS, head: NEXT, approved: 'abc1234' }, deps), 1);
  assert.deepEqual(err, ['REFUSED the head rebased0c is not the approved abc1234de rebased: added eeee5555e "cli: c". Ask for approval of the new head, naming it']);
  assert.equal(clearMerge.mock.callCount(), 0);
  assert.equal(ghFor.mock.callCount(), 0);
});

test('a head refused clearance is never caught up, even when main moved past it', async () => {
  const { deps, err, catchUp, ghFor } = runFixture({ mainTip: MOVED, catchUp: [CAUGHT_UP], clearance: { kind: 'refused', reason: 'T9 has no approval of abc1234de by lead' } });
  assert.equal(await runMerge(ARGS, deps), 1);
  assert.deepEqual(err, ['REFUSED T9 has no approval of abc1234de by lead']);
  assert.equal(catchUp.mock.callCount(), 0);
  assert.equal(ghFor.mock.callCount(), 0);
});

test('without --head the caught-up head is the branch checked out; a ship merge gets the move back and catches nothing up', async () => {
  const checkedOut = runFixture({ mainTip: MOVED, catchUp: [CAUGHT_UP] });
  assert.equal(await runMerge({ ...ARGS, head: null }, checkedOut.deps), 0);
  assert.deepEqual(checkedOut.catchUp.mock.calls[0]?.arguments[0], { head: BRANCH, stem: BRANCH, tip: MOVED, main: 'main', regenerated: ['out/'] });

  const shipped = runFixture({ mainTip: MOVED, catchUp: [CAUGHT_UP] });
  assert.equal((await mergeBranch(['C:/repo', '--head', BRANCH], () => shipped.deps)).kind, 'moved');
  assert.equal(shipped.catchUp.mock.callCount(), 0);
});

test(`main moving past ${MERGE_ATTEMPTS} heads in one merge is refused, each new head numbered from the first`, async () => {
  const { deps, err, catchUp, sweep } = runFixture({ mainTip: MOVED, catchUp: [CAUGHT_UP], rebasedBehind: true });
  assert.equal(await runMerge(ARGS, deps), 1);
  assert.deepEqual(
    catchUp.mock.calls.map(call => [call.arguments[0].head, call.arguments[0].stem]),
    [
      [BRANCH, BRANCH],
      [NEXT, BRANCH],
    ],
  );
  assert.deepEqual(err, [`REFUSED main moved to moved00, which ${NEXT} rebased does not contain: rebase ${NEXT} onto origin/main, push it and run merge again (main moved ${MERGE_ATTEMPTS} times during this merge)`]);
  assert.equal(sweep.mock.callCount(), 0);
});

/** `ship.ts merge --release` on the release task T7, approved at SHA (T4645). */
const RELEASE_ARGS: MergeArgs = { ...ARGS, head: null, release: 'T7', approved: 'abc1234' };

test('--release names the release task, and takes neither --head nor --note-file (T4645)', () => {
  assert.equal(parseArgs(['C:/repo', '--release', 'T7']).release, 'T7');
  assert.throws(() => parseArgs(['C:/repo', '--release', 'seven']), /usage: ship\.ts merge/);
  assert.throws(() => parseArgs(['C:/repo', '--release', 'T7', '--head', RELEASE]), /--release merges the branch repos\.json names for the release pull request, so it takes no --head/);
  assert.throws(() => parseArgs(['C:/repo', '--note-file', 'C:/pr.md', '--release', 'T7']), /--release opens no pull request, so it takes no --note-file/);
});

test("the release pull request merges on its release task's approval, its head read from origin alone (T4645)", async () => {
  const { deps, gitCalls, out, err, clearMerge, clearTaskMerge, releaseRefusal, ghWrites, sweep } = runFixture({ release: {} });
  assert.equal(await runMerge(RELEASE_ARGS, deps), 0, err.join('\n'));
  assert.deepEqual(clearTaskMerge.mock.calls.map(call => call.arguments), [['T7', SHA, 'abc1234']]);
  assert.equal(clearMerge.mock.callCount(), 0, 'the release branch names no task to clear on');
  assert.deepEqual(releaseRefusal.mock.calls.map(call => call.arguments.slice(1)), [[{ head: RELEASE, changelog: 'CHANGELOG.md' }, SHA]]);
  assert.equal(out[0], `merge of the release pull request ${RELEASE} abc1234de: approved by lead on T7`);
  assert.equal(out.at(-1), 'MERGED #3 into main, now at main999');
  assert.ok(!gitCalls.some(call => call === 'rev-parse --abbrev-ref HEAD' || call.startsWith('rev-parse refs/heads/')), 'no local branch is read');
  assert.ok(!ghWrites.some(args => args[1] === `repos/${REPO}/pulls`), 'it opens no pull request');
  assert.deepEqual(sweep.mock.calls.map(call => call.arguments[0]), [{ repo: REPO, head: RELEASE, sha: SHA }]);
});

test('a release pull request that is not open is refused, never opened by the merge (T4645)', async () => {
  const { deps, err, ghWrites } = runFixture({ release: { open: false } });
  assert.equal(await runMerge(RELEASE_ARGS, deps), 1);
  assert.deepEqual(err, [`REFUSED no open pull request from ${RELEASE} into main: the release tool opens it, never a merge`]);
  assert.deepEqual(ghWrites, []);
});

test('a release head holding more than a release, or refused clearance, stops before the token is read or any GitHub call (T4645)', async () => {
  const notRelease = 'src/cli/main.ts is not a version file nor the changelog: the release pull request holds only a release';
  const changed = runFixture({ release: { refusal: notRelease } });
  assert.equal(await runMerge(RELEASE_ARGS, changed.deps), 1);
  assert.deepEqual(changed.err, [`REFUSED ${notRelease}`]);
  assert.equal(changed.clearTaskMerge.mock.callCount(), 0);
  assert.equal(changed.ghFor.mock.callCount(), 0);

  const unapproved = runFixture({ release: {}, clearance: { kind: 'refused', reason: 'T7 has no approval of abc1234de by lead' } });
  assert.equal(await runMerge(RELEASE_ARGS, unapproved.deps), 1);
  assert.deepEqual(unapproved.err, ['REFUSED T7 has no approval of abc1234de by lead']);
  assert.equal(unapproved.ghFor.mock.callCount(), 0);
});

test('a release head main moved past is refused and never caught up: the release tool rewrites it (T4645)', async () => {
  const { deps, err, catchUp, sweep } = runFixture({ release: {}, mainTip: MOVED, catchUp: [CAUGHT_UP] });
  assert.equal(await runMerge(RELEASE_ARGS, deps), 1);
  assert.deepEqual(err, [
    "REFUSED the main branch moved to moved00, past the release pull request's head: the release tool rewrites that head on each move of main, so once its new head's checks pass, ask approval of that head and merge again",
  ]);
  assert.equal(catchUp.mock.callCount(), 0);
  assert.equal(sweep.mock.callCount(), 0);
});

test('--release on a repo whose repos.json lists no release pull request is refused before any GitHub call (T4645)', async () => {
  const { deps, gitCalls, ghFor } = runFixture();
  await assert.rejects(runMerge(RELEASE_ARGS, deps), /Owner\/repo lists no release pull request in repos\.json/);
  assert.ok(!gitCalls.some(call => call.startsWith('fetch')));
  assert.equal(ghFor.mock.callCount(), 0);
});

/** A catch-up whose push failed as main moved again, to AGAIN (T4131). */
const AGAIN = 'again00ddd';
const MOVED_AGAIN: CatchUp = { kind: 'moved', tip: AGAIN, reason: `${BRANCH} abc1234 was caught up, and main moved again to again00 while it was pushed rebased as ${NEXT}, and that push failed: pre-push: version taken` };

test('a head whose catch-up push lost to a merge landing meanwhile is caught up again on the new tip and merges (T4131)', async () => {
  const { deps, out, err, catchUp, sweep } = runFixture({ mainTip: MOVED, catchUp: [MOVED_AGAIN, CAUGHT_UP] });
  assert.equal(await runMerge(ARGS, deps), 0);
  assert.deepEqual(err, []);
  assert.deepEqual(
    catchUp.mock.calls.map(call => call.arguments[0]),
    [
      { head: BRANCH, stem: BRANCH, tip: MOVED, main: 'main', regenerated: ['out/'] },
      { head: BRANCH, stem: BRANCH, tip: AGAIN, main: 'main', regenerated: ['out/'] },
    ],
  );
  assert.equal(out.at(-1), 'MERGED #3 into main, now at main999');
  assert.deepEqual(sweep.mock.calls.map(call => call.arguments[0]), [{ repo: REPO, head: NEXT, sha: REBASED }]);
});

test(`each move during a catch-up counts toward the ${MERGE_ATTEMPTS} a merge allows (T4131)`, async () => {
  const { deps, err, catchUp, ghWrites } = runFixture({ mainTip: MOVED, catchUp: [MOVED_AGAIN] });
  assert.equal(await runMerge(ARGS, deps), 1);
  assert.equal(catchUp.mock.callCount(), MERGE_ATTEMPTS - 1);
  assert.deepEqual(err, [`REFUSED ${MOVED_AGAIN.kind === 'moved' ? MOVED_AGAIN.reason : ''} (main moved ${MERGE_ATTEMPTS} times during this merge)`]);
  assert.equal(ghWrites.length, 0);
});

test("on the ci gate the step's host share is set aside for the checks' wait and the merge call, never taken back once merged (T3336)", async () => {
  const merged = runFixture();
  assert.equal(await runMerge(ARGS, merged.deps), 0);
  assert.deepEqual(merged.shareCalls, ['away after 0 catch-up(s)']);
  const failed = runFixture({ rounds: [[['gates', 'completed', 'failure'], ['test', 'completed', 'success']]] });
  assert.equal(await runMerge(ARGS, failed.deps), 1);
  assert.deepEqual(failed.shareCalls, ['away after 0 catch-up(s)'], 'a refused merge ends its step: nothing to take back');
});

test('a main that moved during the wait takes the share back before the catch-up, and sets it aside again for the next head (T3336)', async () => {
  const { deps, shareCalls } = runFixture({ movesDuringWait: true, catchUp: [CAUGHT_UP] });
  assert.equal(await runMerge(ARGS, deps), 0);
  assert.deepEqual(shareCalls, ['away after 0 catch-up(s)', 'back after 0 catch-up(s)', 'away after 1 catch-up(s)']);
});

test('a head already behind main is caught up with its share kept; a share not taken back refuses the catch-up (T3336)', async () => {
  const stale = runFixture({ mainTip: MOVED, catchUp: [CAUGHT_UP] });
  assert.equal(await runMerge(ARGS, stale.deps), 0);
  assert.deepEqual(stale.shareCalls, ['away after 1 catch-up(s)'], 'turned back before the wait: never set aside for it');

  const lost = runFixture({ movesDuringWait: true, catchUp: [CAUGHT_UP], lostShare: 'teamrig step-back exited 1' });
  assert.equal(await runMerge(ARGS, lost.deps), 1);
  assert.equal(lost.catchUp.mock.callCount(), 0);
  assert.match(lost.err.at(-1) ?? '', /^REFUSED .+, and its host share was not taken back for the catch-up: teamrig step-back exited 1$/);
});

test('a share the step kept (outside a queue, the whole host held) is never taken back; the local gate keeps it throughout (T3336)', async () => {
  const kept = runFixture({ movesDuringWait: true, catchUp: [CAUGHT_UP], away: false });
  assert.equal(await runMerge(ARGS, kept.deps), 0);
  assert.deepEqual(kept.shareCalls, ['away after 0 catch-up(s)', 'away after 1 catch-up(s)']);
  const local = runFixture({ local: {} });
  assert.equal(await runMerge(ARGS, local.deps), 0);
  assert.deepEqual(local.shareCalls, []);
});

test('on the ci gate a head whose checks passed waits its turn behind older merges before main is read for a move (T4196)', async () => {
  const MAIN_READ = 'rev-parse refs/remotes/origin/main';
  const merged = runFixture();
  assert.equal(await runMerge(ARGS, merged.deps), 0);
  assert.equal(merged.gitCalls.filter(call => call === 'turn wait').length, 1);
  const waited = merged.gitCalls.indexOf('turn wait');
  assert.ok(merged.gitCalls.slice(0, waited).includes(MAIN_READ), 'after the check that the head is not behind main');
  assert.ok(merged.gitCalls.slice(waited).includes(MAIN_READ), 'before main is read again for a move during the wait');

  const failed = runFixture({ rounds: [[['gates', 'completed', 'failure'], ['test', 'completed', 'success']]] });
  assert.equal(await runMerge(ARGS, failed.deps), 1);
  assert.equal(failed.gitCalls.includes('turn wait'), false, 'a head whose checks failed lands nothing, so it waits on no one');
});

test("the step's share runs teamrig step-away and step-back only inside a queued step, failing closed on a nonzero exit (T3336)", async () => {
  const runs: string[] = [];
  const codes = [0, 0, 1, 1];
  const runCli = (args: readonly string[]): Promise<number> => {
    runs.push(args.join(' '));
    return Promise.resolve(codes[runs.length - 1] ?? 1);
  };
  const queued = stepShareOf({ TEAMRIG_HOST_LOCK: 'm1' }, runCli);
  assert.deepEqual([await queued.away(), await queued.back(), await queued.away(), await queued.back()], [true, null, false, 'teamrig step-back exited 1']);
  assert.deepEqual(runs, ['step-away', 'step-back', 'step-away', 'step-back']);
  const outside = stepShareOf({ TEAMRIG_HOST_LOCK: ' ' }, runCli);
  assert.equal(await outside.away(), false);
  assert.equal(runs.length, 4, 'nothing runs outside a queued step');
});

test("once merged, drifted or not, it sweeps the merged head's leftovers; a refusal sweeps nothing", async () => {
  const merged = runFixture();
  assert.equal(await runMerge(ARGS, merged.deps), 0);
  assert.deepEqual(
    merged.sweep.mock.calls.map(call => [call.arguments[0], call.arguments[1].main, call.arguments[2] === merged.ghFor.mock.calls[0]?.result]),
    [[{ repo: REPO, head: BRANCH, sha: SHA }, 'main', true]],
  );
  const drifted = runFixture({ mergedTree: 'tree-other' });
  assert.equal(await runMerge(ARGS, drifted.deps), 1);
  assert.equal(drifted.sweep.mock.callCount(), 1);
  for (const fixture of [{ mainTip: MOVED }, { rounds: [[['gates', 'completed', 'failure'], ['test', 'completed', 'success']]] }] as const) {
    const refused = runFixture(fixture);
    assert.equal(await runMerge(ARGS, refused.deps), 1);
    assert.equal(refused.sweep.mock.callCount(), 0);
  }
});

test('the command turns a usage or git error into one line and exit 1', async t => {
  const consoleError = t.mock.method(console, 'error', () => undefined);
  assert.equal(await mergeCommand([]), 1);
  assert.match(String(consoleError.mock.calls[0]?.arguments[0]), /^usage: ship\.ts merge <repo dir>/);
  consoleError.mock.restore();

  const { deps, err } = runFixture({ pushedSha: 'other' });
  assert.equal(await mergeCommand(['C:/repo'], dir => (dir === 'C:/repo' ? deps : runFixture().deps)), 1);
  assert.deepEqual(err, [`${BRANCH} abc1234 is not pushed: push it first`]);
  const merged = runFixture();
  assert.equal(await mergeCommand(['C:/repo', '--timeout-min', '5'], () => merged.deps), 0);
  assert.equal(merged.out.at(-1), 'MERGED #3 into main, now at main999');
});

test("a ship's merge gets a move of main back unsaid, with main's tip; every other end is said and has its code (T2696)", async () => {
  const stale = runFixture({ mainTip: MOVED });
  assert.deepEqual(await mergeBranch(['C:/repo', '--head', BRANCH], () => stale.deps), {
    kind: 'moved',
    tip: MOVED,
    reason: `main moved to moved00, which ${BRANCH} abc1234 does not contain: rebase ${BRANCH} onto origin/main, push it and run merge again`,
  });
  assert.deepEqual([stale.out, stale.err], [[], []]);
  assert.equal(stale.sweep.mock.callCount(), 0);

  const merged = runFixture();
  assert.deepEqual(await mergeBranch(['C:/repo', '--head', BRANCH], () => merged.deps), { kind: 'done', code: 0 });
  assert.equal(merged.out.at(-1), 'MERGED #3 into main, now at main999');
  const refused = runFixture({ rounds: [[['gates', 'completed', 'failure'], ['test', 'completed', 'success']]] });
  assert.deepEqual(await mergeRun(ARGS, refused.deps, () => Promise.resolve(null)), { kind: 'done', code: 1 });
  assert.deepEqual(refused.err, ['REFUSED failed: gates (failure)']);
  const broken = runFixture({ pushedSha: 'other' });
  assert.deepEqual(await mergeBranch(['C:/repo', '--head', BRANCH], () => broken.deps), { kind: 'done', code: 1 });
  assert.deepEqual(broken.err, [`${BRANCH} abc1234 is not pushed: push it first`]);
});

test('the body lists the shipped commits, caps a long list, and ends with the attribution line', () => {
  assert.equal(pullBody(['cli: a', 'docs: b']), '- cli: a\n- docs: b\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)');
  const long = pullBody(['1', '2', '3'], null, 2).split('\n');
  assert.deepEqual(long.slice(0, 3), ['- 1', '- 2', '- … and 1 more']);
});

test('a merge GitHub refuses for a rule set on the repo says that changing the rule is not the change\'s call', async () => {
  const merge = new Error('gh api repos/Owner/repo/pulls/3/merge: HTTP 405: Required status check "gates" is expected.');
  const refused = await mergeOnCi(fakeGitHub({ rounds: [green], merge }).gh, fakeMain(), () => undefined);
  assert.match(refused.kind === 'refused' ? refused.reason : '', /is expected\. \(a rule set on the repo, not the change: changing it is the repo owner's call, so report it and stop\)$/);
});

test('on the local gate it runs the repo runner on the checked-out head, records the pass, then merges', async () => {
  const { deps, out, err, local } = runFixture({ local: {} });
  assert.equal(await runMerge(ARGS, deps), 0);
  assert.deepEqual(err, []);
  assert.deepEqual(local.runs, [RUNNER]);
  assert.ok(out.includes(`pass: ${RUNNER} (2s)`));
  assert.ok(!out.some(line => line.startsWith('check ')), 'no GitHub check is read');
  assert.equal(local.written.length, 1);
  const [record] = local.written;
  assert.equal(record?.slice(0, RECORD_PATH.length + 1), `${RECORD_PATH} `);
  assert.match(record?.slice(RECORD_PATH.length + 1) ?? '', /^\{\n {2}"tree": "tree-checked",\n {2}"commit": "abc1234def",\n {2}"checks": \[\n {4}"runner tools\/ci\/local\.ts"\n {2}\],\n {2}"passedAt": "2026-10-15T10:00:00\.000Z"/);
  assert.equal(out.at(-1), 'MERGED #3 into main, now at main999');
});

test('on the local gate a pass record for the tree skips the checks', async () => {
  const record = JSON.stringify({ tree: 'tree-checked', commit: 'abc1234def', checks: ['lint'], passedAt: '2026-10-15T09:00:00.000Z', node: 'v22.19.0' });
  const { deps, out, local } = runFixture({ local: { record } });
  assert.equal(await runMerge(ARGS, deps), 0);
  assert.deepEqual(local.runs, []);
  assert.deepEqual(local.written, []);
  assert.ok(out.some(line => line.startsWith('local checks: passed earlier on tree tree-ch (commit abc1234, 2026-10-15T09:00:00.000Z, 1 check(s))')));
});

test('on the local gate it refuses another checked-out commit or uncommitted changes before any pull request', async () => {
  for (const [fixture, message] of [
    [{ checkedOut: 'fff0000aaa' }, 'REFUSED C:/repo has fff0000 checked out, not abc1234: the local checks prove the checked-out tree, so check out the branch to merge'],
    [{ status: ' M src/a.ts' }, 'REFUSED C:/repo has uncommitted changes: commit or stash them, the local checks prove only a committed tree'],
  ] as const) {
    const { deps, err, out, ghWrites, local } = runFixture({ local: fixture });
    assert.equal(await runMerge(ARGS, deps), 1);
    assert.deepEqual(err, [message]);
    assert.deepEqual(out, [APPROVED_LINE]);
    assert.deepEqual(ghWrites, [], 'no pull request opened');
    assert.deepEqual(local.runs, []);
  }
});

test('on the local gate a failed runner refuses the merge with its output and records nothing', async () => {
  const { deps, out, err, local, ghWrites } = runFixture({ local: { exit: 1 } });
  assert.equal(await runMerge(ARGS, deps), 1);
  assert.deepEqual(err, [`REFUSED ${RUNNER} failed on tree tree-ch`]);
  assert.ok(out.includes(`FAIL: ${RUNNER} (exit 1, 2s)`));
  assert.ok(out.includes('lint: 1 problem'));
  assert.deepEqual(local.written, []);
  assert.ok(!ghWrites.some(args => args[1]?.endsWith('/merge')));
});

test('--note-file opens the body of the pull request it opens, and a missing note file stops the merge first', async () => {
  assert.deepEqual(parseArgs(['C:/repo', '--note-file', 'C:/notes/gap.md']).noteFile, 'C:/notes/gap.md');
  assert.throws(() => parseArgs(['C:/repo', '--note-file', '--head']), /usage: ship\.ts merge/);
  assert.equal(pullBody(['cli: a'], '## Gap\nmacOS unchecked\n'), '## Gap\nmacOS unchecked\n\n## Commits\n- cli: a\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)');
  assert.equal(pullBody(['cli: a'], ' \n'), pullBody(['cli: a']));

  const { deps, ghWrites } = runFixture();
  const gate: GateDeps = { ...deps.gate, readText: path => (path === 'C:/notes/gap.md' ? '## Gap\nmacOS unchecked\n' : null) };
  assert.equal(await runMerge({ ...ARGS, noteFile: 'C:/notes/gap.md' }, { ...deps, gate }), 0);
  const opened = ghWrites.find(args => args[1] === `repos/${REPO}/pulls`);
  assert.ok(opened?.includes('body=## Gap\nmacOS unchecked\n\nCloses #9\n\n## Commits\n- cli: a\n- docs: b\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'));

  const missing = runFixture();
  await assert.rejects(runMerge({ ...ARGS, noteFile: 'C:/notes/none.md' }, missing.deps), /--note-file C:\/notes\/none\.md: no such file/);
  assert.equal(missing.ghFor.mock.callCount(), 0);
});

test("a ship's pull request takes its issue's title, a Closes line and the repo's labels of its task; the release one is never dressed (T4796)", async () => {
  const { deps, ghWrites, err, pullTask } = runFixture({ repoLabels: ['P1', 'task', 'area:cli', 'bug'] });
  assert.equal(await runMerge(ARGS, deps), 0, err.join('\n'));
  assert.deepEqual(pullTask.mock.calls.map(call => call.arguments), [[BRANCH]]);
  const opened = ghWrites.find(args => args[1] === `repos/${REPO}/pulls`);
  assert.ok(opened?.includes('title=T1: Ship titles'), opened?.join(' '));
  assert.ok(opened?.some(arg => arg.startsWith('body=Closes #9\n\n## Commits\n')), opened?.join(' '));
  // The issue's p3 is the task's p1 now; bug is not this task's type.
  assert.deepEqual(ghWrites.find(args => args[1] === `repos/${REPO}/issues/3/labels`)?.slice(4), ['-f', 'labels[]=P1', '-f', 'labels[]=task', '-f', 'labels[]=area:cli']);

  const release = runFixture({ release: {}, repoLabels: ['P1'] });
  assert.equal(await runMerge(RELEASE_ARGS, release.deps), 0, release.err.join('\n'));
  assert.equal(release.pullTask.mock.callCount(), 0);
  assert.ok(!release.ghWrites.some(args => (args[1] ?? '').endsWith('/labels')));
});

test('a branch whose task links no issue opens no pull request and says how to link one (T4796)', async () => {
  const { deps, err, ghWrites } = runFixture({ task: { ...TASK, ref: null } });
  assert.equal(await runMerge(ARGS, deps), 1);
  assert.equal(err.length, 1);
  assert.match(err[0] ?? '', /^REFUSED T1 links no GitHub issue, so its pull request would close none: open its issue, then teamrig update T1 --ref gh:/);
  assert.deepEqual(ghWrites, []);
});

const FLAKY: RequiredChecks = { names: ['gates', 'test'], summary: null, flaky: ['test'], conditional: [] };
const testFails: readonly JobState[] = [
  ['gates', 'completed', 'success'],
  ['test', 'completed', 'failure'],
];

test('a flaky check failing in the first attempt is re-run once on the same sha and passes; failing again fails (T2988)', async () => {
  const recovers = fakeGitHub({ rounds: [testFails, green] });
  const log: string[] = [];
  const passed = await waitForChecks(recovers.gh, REPO, SHA, HEAD, FLAKY, fakeWaiter(), POLLING, line => log.push(line));
  assert.equal(passed.verdict, 'passed');
  assert.equal(recovers.writes.filter(args => args[1] === RERUN_PATH).length, 1);
  assert.deepEqual(log, ['re-ran run 1: test failed on a check listed as flaky (repos.json), so the same sha goes once more; waiting again, once']);

  const again = fakeGitHub({ rounds: [testFails] });
  const failed = await waitForChecks(again.gh, REPO, SHA, HEAD, FLAKY, fakeWaiter(), POLLING);
  assert.equal(failed.verdict, 'failed');
  assert.equal(again.writes.filter(args => args[1] === RERUN_PATH).length, 1, 'one re-run only');

  const notFlaky = fakeGitHub({ rounds: [testFails, green] });
  assert.equal((await waitForChecks(notFlaky.gh, REPO, SHA, HEAD, CHECKS, fakeWaiter(), POLLING)).verdict, 'failed');
  assert.equal(notFlaky.writes.length, 0, 'a check not listed as flaky is never re-run');
});

test('a check read GitHub gives no answer to is read once more at the next poll; a second in a row, or a 4xx, ends the wait (T2988)', async () => {
  const failingReads = (failures: readonly (string | undefined)[], rounds: readonly (readonly JobState[])[] = [green]): { gh: Gh; reads: () => number } => {
    const { gh } = fakeGitHub({ rounds });
    let reads = 0;
    return {
      gh: args => {
        if (args[1]?.includes('/actions/runs?head_sha=') === true) {
          const failure = failures[reads];
          reads += 1;
          if (failure !== undefined) throw new Error(`gh api ${args[1]}: ${failure}`);
        }
        return gh(args);
      },
      reads: () => reads,
    };
  };
  const once = failingReads(['HTTP 502: Bad Gateway']);
  const waiter = fakeWaiter();
  const log: string[] = [];
  assert.equal((await waitForChecks(once.gh, REPO, SHA, HEAD, CHECKS, waiter, POLLING, line => log.push(line))).verdict, 'passed');
  assert.deepEqual(waiter.slept, [MINUTE]);
  assert.match(log[0] ?? '', /^reading the checks got no answer from GitHub \(gh api repos\/Owner\/repo\/actions\/runs\?head_sha=abc1234def&per_page=100: HTTP 502: Bad Gateway\): reading them once more at the next poll$/);

  const twice = failingReads(['HTTP 502: Bad Gateway', 'timeout awaiting response headers']);
  await assert.rejects(waitForChecks(twice.gh, REPO, SHA, HEAD, CHECKS, fakeWaiter(), POLLING), /timeout awaiting response headers/);
  assert.equal(twice.reads(), 2);

  const refused = failingReads(['HTTP 404: Not Found']);
  await assert.rejects(waitForChecks(refused.gh, REPO, SHA, HEAD, CHECKS, fakeWaiter(), POLLING), /HTTP 404/);
  assert.equal(refused.reads(), 1);

  // Bad reads with a good one between are each read once more: only two in a row end the wait.
  const apart = failingReads(['HTTP 503', undefined, 'HTTP 503'], [[['gates', 'queued', null]], green]);
  assert.equal((await waitForChecks(apart.gh, REPO, SHA, HEAD, CHECKS, fakeWaiter(), POLLING)).verdict, 'passed');
  assert.equal(apart.reads(), 4);
});

test("realMergeDeps reads a head's work by the shipped repos.json, whose release manifest the ship sets again (T4298)", () => {
  // A merge given the version files without the manifest threw on the profile's regenerated paths for every head.
  const repo = new TempRepo('merge-deps').init();
  try {
    repo.write('a.txt', 'a\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'a');
    repo.git('update-ref', 'refs/remotes/origin/main', repo.git('rev-parse', 'HEAD').trim());
    repo.git('remote', 'add', 'origin', 'https://github.com/GeneralA6/teamrig.git');
    repo.write('b.txt', 'b\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'core: b');
    assert.deepEqual(realMergeDeps(repo.dir).workOf('HEAD').map(commit => [commit.subject, commit.merge]), [['core: b', false]]);
  } finally {
    repo.remove();
  }
});
