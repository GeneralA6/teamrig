import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import type { Gh } from './github.ts';
import type { Credential } from './keychain.ts';
import type { GateDeps } from './local-gate.ts';
import { type MainBranch, type MergeArgs, type MergeDeps, type MergeRequest, type MergeResult, type Waiter, ciProof, mainBranchOf, mergeCommand, mergeThroughPull, parseArgs, pullBody, runMerge, waitForChecks } from './merge.ts';
import { parseProfiles } from './repos.ts';

const REPO = 'Owner/repo';
const GH_SECRET = ['github', '_pat_', 'x'].join('');
const SHA = 'abc1234def';
/** The main SHA was cut from; MOVED is a later main that SHA does not contain. */
const BASE = 'base000aaa';
const MOVED = 'moved00bbb';
const MINUTE = 60_000;

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

type JobState = readonly [name: string, status: string, conclusion: string | null];

interface FakeGitHub {
  gh: ReturnType<typeof mock.fn<Gh>>;
  writes: string[][];
}

/** GitHub with one workflow run whose jobs move through `rounds`, one round per read of the jobs. */
function fakeGitHub(options: { rounds: readonly (readonly JobState[])[]; openPullSha?: string | null; merge?: string | Error }): FakeGitHub {
  const writes: string[][] = [];
  let round = 0;
  const pull = (sha: string): string => JSON.stringify({ number: 3, html_url: `https://github.com/${REPO}/pull/3`, head: { ref: 'dev', sha }, base: { ref: 'main' } });
  const gh = mock.fn<Gh>(args => {
    const path = args[1] ?? '';
    if (args.includes('-X')) writes.push([...args]);
    if (path.startsWith(`repos/${REPO}/pulls?state=open`)) return options.openPullSha === null || options.openPullSha === undefined ? '[]' : `[${pull(options.openPullSha)}]`;
    if (path === `repos/${REPO}/pulls`) return pull(SHA);
    if (path === `repos/${REPO}/pulls/3/merge`) {
      if (options.merge instanceof Error) throw options.merge;
      return options.merge ?? '{"sha":"main999","merged":true,"message":"merged"}';
    }
    if (path.includes('/actions/runs?head_sha=')) return '{"workflow_runs":[{"id":1,"workflow_id":1,"event":"pull_request","run_number":1,"run_attempt":1}]}';
    if (path.includes('/actions/runs/1/jobs')) {
      const jobs = options.rounds[Math.min(round, options.rounds.length - 1)] ?? [];
      round += 1;
      return JSON.stringify({ jobs: jobs.map(([name, status, conclusion]) => ({ name, status, conclusion })) });
    }
    if (path.endsWith('/status')) return '{"statuses":[]}';
    throw new Error(`unexpected gh ${args.join(' ')}`);
  });
  return { gh, writes };
}

const request = (overrides: Partial<MergeRequest> = {}): MergeRequest => ({
  repo: REPO,
  head: 'dev',
  base: 'main',
  sha: SHA,
  title: 'Merge dev into main: 2 commit(s)',
  body: '- a\n- b',
  ...overrides,
});

const POLLING = { timeoutMs: 10 * MINUTE, intervalMs: MINUTE };

/** mergeThroughPull on the `ci` gate: checks gates and test on GitHub. */
const mergeOnCi = (gh: Gh, main: MainBranch, log: (line: string) => void): Promise<MergeResult> =>
  mergeThroughPull(request(), gh, main, ciProof(gh, REPO, ['gates', 'test'], fakeWaiter(), POLLING), log);

const green: readonly JobState[] = [
  ['gates', 'completed', 'success'],
  ['test', 'completed', 'success'],
];

test('waits while checks run and returns once all are green', async () => {
  const { gh } = fakeGitHub({ rounds: [[['gates', 'queued', null]], [['gates', 'completed', 'success'], ['test', 'in_progress', null]], green] });
  const waiter = fakeWaiter();
  const result = await waitForChecks(gh, REPO, SHA, ['gates', 'test'], waiter, { timeoutMs: 10 * MINUTE, intervalMs: MINUTE });
  assert.equal(result.verdict, 'passed');
  assert.deepEqual(waiter.slept, [MINUTE, MINUTE]);
});

test('a failed check stops the wait at once', async () => {
  const { gh } = fakeGitHub({ rounds: [[['gates', 'completed', 'failure'], ['test', 'queued', null]]] });
  const waiter = fakeWaiter();
  assert.equal((await waitForChecks(gh, REPO, SHA, ['gates', 'test'], waiter, { timeoutMs: 10 * MINUTE, intervalMs: MINUTE })).verdict, 'failed');
  assert.deepEqual(waiter.slept, []);
});

test('a check still missing at the deadline times out, and the last sleep stops at the deadline', async () => {
  const { gh } = fakeGitHub({ rounds: [[['gates', 'completed', 'success']]] });
  const waiter = fakeWaiter();
  const result = await waitForChecks(gh, REPO, SHA, ['gates', 'test'], waiter, { timeoutMs: 150_000, intervalMs: MINUTE });
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

test('a merge GitHub refuses (not mergeable, head moved) is reported, not thrown', async () => {
  const refused = await mergeOnCi(fakeGitHub({ rounds: [green], merge: new Error('gh api repos/Owner/repo/pulls/3/merge: HTTP 409: Head branch was modified') }).gh, fakeMain(), () => undefined);
  assert.deepEqual(refused.kind === 'refused' ? refused.reason : refused, 'GitHub refused the merge: gh api repos/Owner/repo/pulls/3/merge: HTTP 409: Head branch was modified');
  const unmerged = await mergeOnCi(fakeGitHub({ rounds: [green], merge: '{"merged":false,"message":"Rebase failed"}' }).gh, fakeMain(), () => undefined);
  assert.deepEqual(unmerged.kind === 'refused' ? unmerged.reason : unmerged, 'GitHub refused the merge: Rebase failed');
});

const STALE = 'main moved to moved00, which dev abc1234 does not contain: rebase dev onto origin/main, push it and run merge again';

test('refuses a branch main moved past before opening a pull request or reading a check', async () => {
  const { gh } = fakeGitHub({ rounds: [green] });
  const result = await mergeOnCi(gh, fakeMain({ tips: [MOVED] }), () => undefined);
  assert.deepEqual(result.kind === 'refused' ? [result.pull, result.reason] : result, [null, STALE]);
  assert.equal(gh.mock.callCount(), 0);
});

test('refuses without merging when main moves while the checks run', async () => {
  const { gh, writes } = fakeGitHub({ rounds: [green] });
  const main = fakeMain({ tips: [BASE, MOVED] });
  const result = await mergeOnCi(gh, main, () => undefined);
  assert.deepEqual(result.kind === 'refused' ? [result.pull?.number, result.reason] : result, [3, STALE]);
  assert.ok(!writes.some(args => args[1]?.endsWith('/merge')));
  assert.deepEqual(main.reads, [BASE, MOVED]);
});

test('reads main before opening, again right before merging, and once more to confirm the merged tree is the checked one', async () => {
  const main = fakeMain();
  const result = await mergeOnCi(fakeGitHub({ rounds: [green] }).gh, main, () => undefined);
  assert.equal(result.kind, 'merged');
  assert.equal(main.reads.length, 3);
});

test('reports a merge onto a main that moved after the last read, and one whose tree it could not compare', async () => {
  const drifted = await mergeOnCi(fakeGitHub({ rounds: [green] }).gh, fakeMain({ mergedTree: 'tree-other' }), () => undefined);
  assert.deepEqual(drifted.kind === 'drifted' ? [drifted.pull.number, drifted.sha, drifted.reason] : drifted, [
    3,
    'main999',
    'main moved just before the merge: main999 is not the tree the checks passed on abc1234; check it (a plugin version bump may be lost) and ship a fix',
  ]);
  for (const [treeError, detail] of [[new Error('fatal: bad object main999'), 'fatal: bad object main999'], ['git exited 128', 'git exited 128']] as const) {
    const unknown = await mergeOnCi(fakeGitHub({ rounds: [green] }).gh, fakeMain({ treeError }), () => undefined);
    assert.deepEqual(unknown.kind === 'drifted' ? unknown.reason : unknown, `could not compare main999 with the checked abc1234: ${detail}`);
  }
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

test('reads the repo dir and the polling flags', () => {
  assert.deepEqual(parseArgs(['C:/repo']), { dir: 'C:/repo', head: null, timeoutMin: 45, intervalS: 30, noteFile: null });
  assert.deepEqual(parseArgs(['C:/repo', '--head', 'feature/x', '--timeout-min', '5', '--interval-s', '10']), { dir: 'C:/repo', head: 'feature/x', timeoutMin: 5, intervalS: 10, noteFile: null });
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
}

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
} {
  const gitCalls: string[] = [];
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
  };
  const out: string[] = [];
  const err: string[] = [];
  const { gh, writes } = fakeGitHub({ rounds: fixture.rounds ?? [green] });
  const local = fakeGate(fixture.local ?? {}, line => out.push(line));
  const ghFor = mock.fn((_token: string): Gh => gh);
  const renamedCallers = mock.fn((_base: string, _tip: string, _repo: string): string | null => fixture.renamedCallers ?? null);
  const sweep = mock.fn<MergeDeps['sweep']>(() => undefined);
  const deps: MergeDeps = {
    git: (...args) => {
      const key = args.join(' ');
      gitCalls.push(key);
      const answer = answers[key];
      if (answer === undefined) throw new Error(`unexpected git ${key}`);
      return answer;
    },
    profiles: parseProfiles(`{"${REPO}":{"main":"main","gate":"${fixture.local === undefined ? 'ci' : 'local'}","checks":["gates","test"],${LOCAL_PROFILE}}}`),
    credential: () => fixture.credential ?? { kind: 'found', secret: GH_SECRET },
    ghFor,
    waiter: fakeWaiter(),
    gate: local.gate,
    renamedCallers,
    sweep,
    out: line => out.push(line),
    err: line => err.push(line),
  };
  return { deps, gitCalls, out, err, ghFor, ghWrites: writes, local, renamedCallers, sweep };
}

const ARGS: MergeArgs = { dir: 'C:/repo', head: BRANCH, timeoutMin: 10, intervalS: 60, noteFile: null };

test('merges the pushed head of a repo found from its origin remote, with the token from the keychain', async () => {
  const { deps, gitCalls, out, err, ghFor } = runFixture();
  assert.equal(await runMerge(ARGS, deps), 0);
  assert.deepEqual(err, []);
  assert.equal(out.at(-1), 'MERGED #3 into main, now at main999');
  assert.equal(ghFor.mock.calls[0]?.arguments[0], GH_SECRET);
  assert.equal(gitCalls[1], `fetch --quiet origin ${BRANCH} main`);
  assert.ok(!gitCalls.includes('rev-parse --abbrev-ref HEAD'), 'an explicit --head is not second-guessed');
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
  assert.deepEqual(out, []);
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

test('a branch main moved past is refused before any pull request; a merge onto a moved main exits 1 after MERGED', async () => {
  const stale = runFixture({ mainTip: MOVED });
  assert.equal(await runMerge(ARGS, stale.deps), 1);
  assert.deepEqual(stale.err, [`REFUSED main moved to moved00, which ${BRANCH} abc1234 does not contain: rebase ${BRANCH} onto origin/main, push it and run merge again`]);
  assert.deepEqual(stale.out, []);

  const drifted = runFixture({ mergedTree: 'tree-other' });
  assert.equal(await runMerge(ARGS, drifted.deps), 1);
  assert.equal(drifted.out.at(-1), 'MERGED #3 into main, now at main999');
  assert.match(drifted.err[0] ?? '', /^DRIFTED main moved just before the merge: main999 is not the tree the checks passed on abc1234/);
});

test("once merged, drifted or not, it sweeps the merged head's leftovers; a refusal sweeps nothing", async () => {
  const merged = runFixture();
  assert.equal(await runMerge(ARGS, merged.deps), 0);
  assert.deepEqual(merged.sweep.mock.calls.map(call => [call.arguments[0], call.arguments[1].main]), [[BRANCH, 'main']]);
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
    assert.deepEqual(out, []);
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
  assert.ok(opened?.includes('body=## Gap\nmacOS unchecked\n\n## Commits\n- cli: a\n- docs: b\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'));

  const missing = runFixture();
  await assert.rejects(runMerge({ ...ARGS, noteFile: 'C:/notes/none.md' }, missing.deps), /--note-file C:\/notes\/none\.md: no such file/);
  assert.equal(missing.ghFor.mock.callCount(), 0);
});
