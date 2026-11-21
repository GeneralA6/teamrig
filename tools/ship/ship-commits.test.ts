import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { MergeClearance, WorkCommit } from './approval.ts';
import type { GateVerdict } from './local-gate.ts';
import type { MainMove, MergeExit } from './merge.ts';
import { DIST, leaveForReview, parseNumstat, raisePathsOf, SHIP_ATTEMPTS, shipCommits, weighDist, type ShipDeps } from './ship-commits.ts';
import { isRaiseOnly } from './ship-plan.ts';
import { TEAMRIG_RELEASE_STAMPS, TEAMRIG_VERSION_FILES } from './version-bump.ts';
import type { MergeChecks } from './repos.ts';
import type { Chunk, ShipArgs } from './ship-plan.ts';
import type { SyncResult } from './sync.ts';
import { KIT_VERSION } from '../../src/core/version.ts';

const ARGS: ShipArgs = { repo: 'C:/repo', plan: 'plan.json', base: 'origin/main', merge: false, noteFile: null, approved: null };
const CHUNKS: readonly Chunk[] = [
  { files: ['src/a.ts'], subject: 'core: a', body: 'why a' },
  { files: ['src/b.ts', 'src/b.test.ts'], subject: 'release: 0.134.0', body: 'raises 0.134.0' },
];
const PASS: GateVerdict = { passed: true, tree: 'tree000', record: 'C:/records/tree000.json', reused: false };
const TRAILER = `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nMade-with: teamrig ${KIT_VERSION}`;

interface FakeOptions {
  readonly sync?: SyncResult;
  readonly numstat?: string;
  readonly verdict?: GateVerdict;
  /** The first step whose event starts with this throws, like a failed command. */
  readonly failOn?: string;
  /** What each merge returns, in turn; the last one repeats. */
  readonly mergeExits?: readonly MergeExit[];
  /** git's stdout by its args joined with spaces, before the defaults. */
  readonly answers?: Readonly<Record<string, string>>;
  /** What each look at main after failed local checks finds, in turn; the last one repeats; none by default. */
  readonly moves?: readonly (MainMove | null)[];
  /** What the merge's clearance finds; the lead's approval by default. */
  readonly clearance?: MergeClearance;
  /** What each fingerprint of the change finds, in turn; the last one repeats; the same one by default. */
  readonly patches?: readonly string[];
  /** The work commits each rev carries, by rev; none by default. */
  readonly work?: Readonly<Record<string, readonly WorkCommit[]>>;
  /** The git call, its args joined with spaces, that fails like git with no such commit. */
  readonly gitFails?: string;
  /** What a --merge run checks locally (repos.json `mergeChecks`); the whole suite by default. */
  readonly mergeChecks?: MergeChecks;
}

interface Fake {
  readonly deps: ShipDeps;
  /** Every command, git call, gate run, push and merge, in order. */
  readonly events: string[];
  readonly logs: string[];
  /** The subjects of the plan each take back was given, in order. */
  readonly takenBack: string[][];
}

/** The branch and head every fake run has checked out, read by a --merge run's clearance. */
const HEAD_SHA = '5efae2e918f0a149994f35367b4546c6229e7d3f';
const BRANCH_ANSWERS: Readonly<Record<string, string>> = { 'rev-parse --abbrev-ref HEAD': 't827-ship-tool\n', 'rev-parse HEAD': `${HEAD_SHA}\n` };

function fake(options: FakeOptions = {}): Fake {
  const events: string[] = [];
  const logs: string[] = [];
  const takenBack: string[][] = [];
  let merges = 0;
  let looks = 0;
  let patches = 0;
  const step = (event: string): void => {
    events.push(event);
    if (options.failOn !== undefined && event.startsWith(options.failOn)) throw new Error(`${event} failed`);
  };
  const deps: ShipDeps = {
    run: (command, args) => step(`${command} ${args.join(' ')}`),
    node: (args) => step(`node ${args.join(' ')}`),
    git: (args) => {
      const joined = args.join(' ');
      events.push(`git ${joined}`);
      if (joined === options.gitFails) throw new Error(`git ${joined} failed`);
      const answer = options.answers?.[joined] ?? BRANCH_ANSWERS[joined];
      if (answer !== undefined) return answer;
      return args[0] === 'diff' ? (options.numstat ?? '') : 'abc1234 core: a\n';
    },
    log: (line) => logs.push(line),
    takeBack: (chunks, base) => {
      events.push(`take back ${chunks.length} chunk(s) since ${base}`);
      takenBack.push(chunks.map((chunk) => chunk.subject));
    },
    holdHead: () => {
      events.push('hold head');
      return { head: HEAD_SHA, restore: () => events.push('put back') };
    },
    sync: () => {
      events.push('sync');
      return options.sync ?? { kind: 'current', sets: '0.134.0' };
    },
    buildSteps: () => [['tools/build/bundle.ts']],
    proveTree: (scope) => {
      events.push(scope === 'full' ? 'prove' : 'prove short');
      return options.verdict ?? PASS;
    },
    mergeChecks: options.mergeChecks ?? 'full',
    push: () => {
      events.push('push');
      return 't827-ship-tool';
    },
    merge: (branch) => {
      events.push(`merge ${branch}`);
      const exits = options.mergeExits ?? [];
      return Promise.resolve(exits[merges++] ?? exits.at(-1) ?? { kind: 'done', code: 0 });
    },
    mainMove: () => {
      events.push('look at main');
      const moves = options.moves ?? [];
      return moves[looks++] ?? moves.at(-1) ?? null;
    },
    clearMerge: (branch, head, approved) => {
      events.push(`clear ${branch} ${head} ${approved ?? 'none'}`);
      return Promise.resolve(options.clearance ?? { kind: 'approved', by: 'lead' });
    },
    patchOf: (rev) => {
      events.push(`patch ${rev}`);
      const found = options.patches ?? [];
      return found[patches++] ?? found.at(-1) ?? 'patch0';
    },
    workOf: (rev) => {
      events.push(`work ${rev}`);
      return options.work?.[rev] ?? [];
    },
  };
  return { deps, events, logs, takenBack };
}

const committed = (subject: string, body: string, ...extra: string[]): string =>
  ['git commit -q -s -m', subject, '-m', body, ...extra.flatMap((line) => ['-m', line]), '-m', TRAILER].join(' ');

test('takes back an earlier run first, then syncs, commits each chunk, builds and proves the tree, and stops there without --merge', async () => {
  const { deps, events } = fake();
  assert.equal(await shipCommits(ARGS, CHUNKS, deps), 0);
  assert.deepEqual(events, [
    'hold head',
    'take back 2 chunk(s) since origin/main',
    'sync',
    'git status --porcelain -- src/a.ts',
    'git status --porcelain -- src/b.ts src/b.test.ts',
    'git add -- src/a.ts',
    committed('core: a', 'why a'),
    'git add -- src/b.ts src/b.test.ts',
    committed('release: 0.134.0', 'raises 0.134.0'),
    'node tools/build/bundle.ts',
    `git ls-files -- ${DIST}`,
    `git add -- ${DIST}`,
    'git diff --cached --numstat',
    'prove',
    'git log --oneline origin/main..HEAD',
  ]);
});

test('builds a dist the tree does not track for the checks alone, committing none and leaving none to take back (T4355)', async () => {
  const { deps, events, logs } = fake({ numstat: `3\t1\t${DIST}/a.js\n`, answers: { [`ls-files -- ${DIST}`]: '' } });
  assert.equal(await shipCommits(ARGS, CHUNKS, deps), 0);
  assert.deepEqual(events.slice(events.indexOf('node tools/build/bundle.ts')), [
    'node tools/build/bundle.ts',
    `git ls-files -- ${DIST}`,
    'prove',
    'git log --oneline origin/main..HEAD',
  ]);
  assert.ok(!logs.some((line) => line.startsWith('dist:')));
});

test('commits a rebuilt dist apart, with a Large-commit line only when it goes over the size rule', async () => {
  const small = fake({ numstat: `3\t1\t${DIST}/a.js\n` });
  await shipCommits(ARGS, CHUNKS, small.deps);
  assert.ok(small.events.includes(committed('build: rebuild the plugin dist', 'Compiled from the commits above by npm run build.')));
  assert.ok(small.logs.includes('dist: 1 file(s), 4 line(s)'));

  const large = fake({ numstat: `401\t0\t${DIST}/a.js\n` });
  await shipCommits(ARGS, CHUNKS, large.deps);
  assert.ok(large.events.includes(committed('build: rebuild the plugin dist', 'Compiled from the commits above by npm run build.', 'Large-commit: generated by npm run build from the reviewed source')));
  assert.ok(large.logs.includes('dist: 1 file(s), 401 line(s), over the size rule'));
});

/** A plan whose last chunk raises the version, named in its subject as SKILL.md writes it. */
const WORK: Chunk = { files: ['src/a.ts'], subject: 'core: a', body: 'why a, since 0.134.0' };
const RAISE: Chunk = { files: ['plugins/teamrig/.claude-plugin/plugin.json', 'src/core/version.ts'], subject: 'plugin: version 0.134.0, a', body: 'raises 0.134.0' };
const RAISING: readonly Chunk[] = [WORK, RAISE];

test('sets the version raise again in the chunks when the sync rebased onto a main with a newer version', async () => {
  const { deps, events } = fake({ sync: { kind: 'rebased', onto: 'def5678', sets: '0.135.0' } });
  await shipCommits(ARGS, RAISING, deps);
  assert.ok(events.includes(committed('core: a', 'why a, since 0.135.0')));
  assert.ok(events.includes(committed('plugin: version 0.135.0, a', 'raises 0.135.0')));
  assert.ok(!events.some((event) => event.includes('0.134.0')));
});

test('a rerun on an unmoved main commits the version its failed run already set, not the plan\'s (T1472)', async () => {
  const { deps, events } = fake({ sync: { kind: 'current', sets: '0.135.0' } });
  await shipCommits(ARGS, RAISING, deps);
  assert.ok(events.includes(committed('plugin: version 0.135.0, a', 'raises 0.135.0')));
  assert.ok(!events.some((event) => event.includes('0.134.0')));
});

test('keeps the plan as written when the files set the version it names', async () => {
  const { deps, events } = fake({ sync: { kind: 'rebased', onto: 'def5678', sets: '0.134.0' } });
  await shipCommits(ARGS, RAISING, deps);
  assert.ok(events.includes(committed('plugin: version 0.134.0, a', 'raises 0.134.0')));
});

const VERSION_FILES = 'plugins/teamrig/.claude-plugin/plugin.json src/core/version.ts';
/** RAISING as a session may write it, the raise first: the ship commits it after the work all the same. */
const RAISE_FIRST: readonly Chunk[] = [RAISE, WORK];
const DIST_STAT = `3\t1\t${DIST}/a.js\n`;

test('without --merge, the review head holds the work alone: the raise and the dist are committed for the checks, then taken back', async () => {
  const { deps, events, logs, takenBack } = fake({ numstat: DIST_STAT });
  assert.equal(await shipCommits(ARGS, RAISE_FIRST, deps), 0);
  assert.deepEqual(takenBack, [['core: a', 'plugin: version 0.134.0, a']]);
  assert.deepEqual(events.slice(events.indexOf('git add -- src/a.ts')), [
    'git add -- src/a.ts',
    committed('core: a', 'why a, since 0.134.0'),
    `git add -- ${VERSION_FILES}`,
    committed('plugin: version 0.134.0, a', 'raises 0.134.0'),
    'node tools/build/bundle.ts',
    `git ls-files -- ${DIST}`,
    `git add -- ${DIST}`,
    'git diff --cached --numstat',
    `git add -- ${DIST}`,
    committed('build: rebuild the plugin dist', 'Compiled from the commits above by npm run build.'),
    'prove',
    'git reset -q --soft HEAD~2',
    `git restore --staged -- ${VERSION_FILES}`,
    `git restore --source=HEAD --staged --worktree -- ${DIST}`,
    'git log --oneline origin/main..HEAD',
  ]);
  assert.ok(logs.some((line) => line.includes('left for review: the work commits')));
});

test('without --merge, a raise that also stamps a migration\'s firstRelease is committed last and taken back whole (T4171)', async () => {
  const stamped: Chunk = { files: [...RAISE.files, 'src/config/migrate.ts'], subject: 'plugin: version 0.134.0, a migration', body: 'raises 0.134.0' };
  const { deps, events, takenBack } = fake({ numstat: DIST_STAT });
  assert.equal(await shipCommits(ARGS, [stamped, WORK], deps), 0);
  assert.deepEqual(takenBack, [['core: a', 'plugin: version 0.134.0, a migration']]);
  assert.deepEqual(events.filter((event) => event.startsWith('git commit')), [
    committed('core: a', 'why a, since 0.134.0'),
    committed('plugin: version 0.134.0, a migration', 'raises 0.134.0'),
    committed('build: rebuild the plugin dist', 'Compiled from the commits above by npm run build.'),
  ]);
  assert.deepEqual(
    events.filter((event) => event.startsWith('git reset') || event.startsWith('git restore')),
    ['git reset -q --soft HEAD~2', `git restore --staged -- ${VERSION_FILES} src/config/migrate.ts`, `git restore --source=HEAD --staged --worktree -- ${DIST}`],
  );
});

test('without --merge and with no rebuilt dist, only the raise is taken back', async () => {
  const { deps, events } = fake();
  await shipCommits(ARGS, RAISING, deps);
  assert.deepEqual(
    events.filter((event) => event.startsWith('git reset') || event.startsWith('git restore')),
    ['git reset -q --soft HEAD~1', `git restore --staged -- ${VERSION_FILES}`],
  );
});

test('with --merge, the raise and the dist are committed once after the work and pushed, nothing taken back', async () => {
  const { deps, events } = fake({ numstat: DIST_STAT });
  assert.equal(await shipCommits({ ...ARGS, merge: true }, RAISE_FIRST, deps), 0);
  assert.deepEqual(events.filter((event) => event.startsWith('git commit')), [
    committed('core: a', 'why a, since 0.134.0'),
    committed('plugin: version 0.134.0, a', 'raises 0.134.0'),
    committed('build: rebuild the plugin dist', 'Compiled from the commits above by npm run build.'),
  ]);
  assert.ok(!events.some((event) => event.startsWith('git reset') || event.startsWith('git restore')));
  assert.deepEqual(events.slice(-2), ['push', 'merge t827-ship-tool']);
});

test('without --merge, a tree the gate does not pass keeps its raise and dist commits, for the rerun to take back', async () => {
  const { deps, events } = fake({ numstat: DIST_STAT, verdict: { passed: false, reason: 'tools/ci/local.ts failed on tree tree000' } });
  await assert.rejects(shipCommits(ARGS, RAISING, deps), /^Error: REFUSED tools\/ci\/local\.ts failed on tree tree000$/);
  assert.ok(!events.some((event) => event.startsWith('git reset') || event.startsWith('look at main')));
});

test("leaveForReview in a real repo: the work commit stays, the raise is left uncommitted and the dist is the head's", () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-'));
  try {
    const git = (args: readonly string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    const write = (path: string, text: string): void => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    const commitAll = (subject: string): void => {
      git(['add', '-A']);
      git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', subject]);
    };
    git(['init', '-q', '-b', 'main']);
    for (const [path, text] of [['src/a.ts', 'a\n'], ['plugins/teamrig/.claude-plugin/plugin.json', '0.1.0\n'], ['src/core/version.ts', '0.1.0\n'], [`${DIST}/a.js`, 'a\n']] as const) write(path, text);
    commitAll('base');
    write('src/a.ts', 'a2\n');
    commitAll('core: a');
    const work = git(['rev-parse', 'HEAD']);
    write('plugins/teamrig/.claude-plugin/plugin.json', '0.2.0\n');
    write('src/core/version.ts', '0.2.0\n');
    commitAll('plugin: version 0.2.0, a');
    write(`${DIST}/a.js`, 'a2\n');
    write(`${DIST}/b.js`, 'b\n');
    commitAll('build: rebuild the plugin dist');

    leaveForReview({ ...fake().deps, git }, [RAISE], true);

    assert.equal(git(['rev-parse', 'HEAD']), work);
    assert.equal(git(['status', '--porcelain']), ' M plugins/teamrig/.claude-plugin/plugin.json\n M src/core/version.ts\n');
    assert.equal(git(['show', 'HEAD:src/a.ts']), 'a2\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a version chunk whose files hold no raise is refused before any commit, naming the fix (T2823)', async () => {
  const { deps, events } = fake({ answers: { 'status --porcelain -- plugins/teamrig/.claude-plugin/plugin.json src/core/version.ts': '' } });
  await assert.rejects(
    shipCommits(ARGS, RAISING, deps),
    /^Error: REFUSED the plan's chunk "plugin: version 0\.134\.0, a" commits nothing: plugins\/teamrig\/\.claude-plugin\/plugin\.json, src\/core\/version\.ts hold no uncommitted change; raise the version in plugins\/teamrig\/\.claude-plugin\/plugin\.json and src\/core\/version\.ts, left uncommitted, then ship again$/,
  );
  assert.ok(!events.some((event) => event.startsWith('git add') || event.startsWith('git commit')));
});

test('any other chunk with nothing to commit is refused before any commit too (T2823)', async () => {
  const { deps, events } = fake({ answers: { 'status --porcelain -- src/a.ts': ' \n' } });
  await assert.rejects(
    shipCommits(ARGS, CHUNKS, deps),
    /^Error: REFUSED the plan's chunk "core: a" commits nothing: src\/a\.ts hold no uncommitted change; leave its change uncommitted, or take the chunk out of the plan, then ship again$/,
  );
  assert.ok(!events.some((event) => event.startsWith('git add') || event.startsWith('git commit')));
});

test("an empty plan ships the branch's own commits as they are: no take back, no commit of its own, then the build and the gate (T4116)", async () => {
  const { deps, events } = fake({ answers: { 'rev-list --count origin/main..HEAD': '1\n' } });
  assert.equal(await shipCommits(ARGS, [], deps), 0);
  assert.deepEqual(events, [
    'hold head',
    'take back 0 chunk(s) since origin/main',
    'sync',
    'git rev-list --count origin/main..HEAD',
    'node tools/build/bundle.ts',
    `git ls-files -- ${DIST}`,
    `git add -- ${DIST}`,
    'git diff --cached --numstat',
    'prove',
    'git log --oneline origin/main..HEAD',
  ]);
});

test('an empty plan with --merge pushes and merges the commits the branch carries (T4116)', async () => {
  const { deps, events } = fake({ answers: { 'rev-list --count origin/main..HEAD': '1\n' } });
  assert.equal(await shipCommits({ ...ARGS, merge: true }, [], deps), 0);
  assert.ok(!events.some((event) => event.startsWith('git commit')));
  assert.deepEqual(events.slice(-2), ['push', 'merge t827-ship-tool']);
});

test('an empty plan on a branch that carries no commit is refused before the build (T4116)', async () => {
  const { deps, events } = fake({ answers: { 'rev-list --count origin/main..HEAD': '0\n' } });
  await assert.rejects(
    shipCommits(ARGS, [], deps),
    /^Error: REFUSED the plan has no chunks and the branch carries no commit past origin\/main: there is nothing to ship$/,
  );
  assert.ok(!events.some((event) => event.startsWith('node ')));
});

test('a plan with chunks never asks how many commits the branch carries (T4116)', async () => {
  const { deps, events } = fake();
  await shipCommits(ARGS, CHUNKS, deps);
  assert.ok(!events.some((event) => event.startsWith('git rev-list')));
});

test('a refusal or a failed step before the plan is committed again puts the branch back on the head it started from (#1240)', async () => {
  const empty = fake({ answers: { 'status --porcelain -- src/a.ts': '' } });
  await assert.rejects(shipCommits(ARGS, CHUNKS, empty.deps), /^Error: REFUSED the plan's chunk "core: a" commits nothing/);
  assert.equal(empty.events.at(-1), 'put back');
  const commitFails = fake({ failOn: 'git commit -q -s -m release' });
  await assert.rejects(shipCommits(ARGS, CHUNKS, commitFails.deps), /^Error: git commit -q -s -m release/);
  assert.equal(commitFails.events.at(-1), 'put back');
});

test('once the plan is committed again, a failed build or gate leaves the commits, for the rerun to take back (#1240)', async () => {
  for (const options of [{ failOn: 'node tools/build/bundle.ts' }, { verdict: { passed: false, reason: 'tools/ci/local.ts failed' } as const }]) {
    const { deps, events } = fake(options);
    await assert.rejects(shipCommits(ARGS, CHUNKS, deps));
    assert.ok(!events.includes('put back'));
  }
});

test('runs no typecheck or coverage suite of its own: the gate runs each once on the committed tree (T4064)', async () => {
  const { deps, events } = fake();
  await shipCommits(ARGS, CHUNKS, deps);
  assert.ok(!events.some((event) => event.includes('typescript/bin/tsc') || event.includes('coverage-cli')));
  assert.equal(events.filter((event) => event === 'prove').length, 1);
});

test('a failed build step stops before the gate', async () => {
  const { deps, events } = fake({ failOn: 'node tools/build/bundle.ts' });
  await assert.rejects(shipCommits(ARGS, CHUNKS, deps), /^Error: node tools\/build\/bundle\.ts failed$/);
  assert.ok(!events.includes('prove'));
});

test('a tree the gate does not pass is refused before any push, with --merge too', async () => {
  const { deps, events } = fake({ verdict: { passed: false, reason: 'tools/ci/local.ts failed on tree tree000' } });
  await assert.rejects(shipCommits({ ...ARGS, merge: true }, CHUNKS, deps), /^Error: REFUSED tools\/ci\/local\.ts failed on tree tree000$/);
  assert.ok(!events.includes('push'));
  // With --merge a failed gate first asks whether main moved past the branch (T2725); here it did not.
  assert.deepEqual(events.slice(-2), ['git log --oneline origin/main..HEAD', 'look at main']);
});

test('with --merge, pushes the change branch after the gate and returns the merge exit code', async () => {
  const { deps, events, logs } = fake({ mergeExits: [{ kind: 'done', code: 3 }] });
  assert.equal(await shipCommits({ ...ARGS, merge: true }, CHUNKS, deps), 3);
  assert.deepEqual(events.slice(-4), ['git log --oneline origin/main..HEAD', 'patch HEAD', 'push', 'merge t827-ship-tool']);
  assert.ok(logs.includes('\npushed t827-ship-tool; merging:'));
});

test('with --merge and the switch on, the whole suite is left to required CI: a short proof, then the push and the merge (T3414)', async () => {
  const { deps, events, logs } = fake({ mergeChecks: 'changed' });
  assert.equal(await shipCommits({ ...ARGS, merge: true }, CHUNKS, deps), 0);
  assert.ok(!events.includes('prove'), events.join('\n'));
  assert.deepEqual(events.slice(-5), ['prove short', 'git log --oneline origin/main..HEAD', 'patch HEAD', 'push', 'merge t827-ship-tool']);
  assert.ok(logs.includes('\nshort checks (required CI runs the whole suite on the pull request):'));
});

test('with the switch on, a run without --merge still proves the tree with the whole suite (T3414)', async () => {
  const { deps, events, logs } = fake({ mergeChecks: 'changed' });
  assert.equal(await shipCommits(ARGS, CHUNKS, deps), 0);
  assert.ok(events.includes('prove') && !events.includes('prove short'));
  assert.ok(logs.includes('\nlocal checks:'));
});

test('with --merge, clears the merge of the branch at its head and fingerprints its change before anything changes (T2788)', async () => {
  const { deps, events, logs } = fake();
  assert.equal(await shipCommits({ ...ARGS, merge: true, approved: '5efae2e91' }, CHUNKS, deps), 0);
  assert.deepEqual(events.slice(0, 6), [
    'git rev-parse --abbrev-ref HEAD',
    'git rev-parse HEAD',
    `clear t827-ship-tool ${HEAD_SHA} 5efae2e91`,
    `patch ${HEAD_SHA}`,
    'hold head',
    'take back 2 chunk(s) since origin/main',
  ]);
  assert.ok(logs.includes('merge of t827-ship-tool 5efae2e91: approved by lead'));
  assert.ok(!events.some((event) => event.startsWith('work ')), 'the approved head itself needs no work compare');
});

/** The approved head a rebase left behind, and its work commits; the rebased HEAD_SHA carries the same by default. */
const APPROVED_SHA = '61854f9e15a3393c82640073cd7e69c12c3dd435';
const workOf = (sha: string, subject: string, patch: string): WorkCommit => ({ sha, subject, merge: false, patch });
const APPROVED_WORK = [workOf(APPROVED_SHA, 'ship: a', 'pa'), workOf('7777777777', 'docs: a', 'pd')];
const rebased = (headWork: readonly WorkCommit[]): FakeOptions => ({
  answers: { 'rev-parse --verify --quiet 61854f9e1^{commit}': `${APPROVED_SHA}\n` },
  work: { [APPROVED_SHA]: APPROVED_WORK, [HEAD_SHA]: headWork },
});

test('with --merge on a rebase of the approved head, the same work commits patch for patch clear the approved head, no new approval (T2913)', async () => {
  const { deps, events, logs } = fake(rebased([workOf(HEAD_SHA, 'ship: a', 'pa'), workOf('8888888888', 'docs: a', 'pd')]));
  assert.equal(await shipCommits({ ...ARGS, merge: true, approved: '61854f9e1' }, CHUNKS, deps), 0);
  assert.deepEqual(events.slice(0, 9), [
    'git rev-parse --abbrev-ref HEAD',
    'git rev-parse HEAD',
    'git rev-parse --verify --quiet 61854f9e1^{commit}',
    `work ${APPROVED_SHA}`,
    `work ${HEAD_SHA}`,
    `clear t827-ship-tool ${APPROVED_SHA} 61854f9e1`,
    `patch ${APPROVED_SHA}`,
    'hold head',
    'take back 2 chunk(s) since origin/main',
  ]);
  assert.ok(logs.includes("head 5efae2e91 carries the approved 61854f9e1's 2 work commit(s), patch for patch"));
  assert.ok(logs.includes('merge of t827-ship-tool 61854f9e1: approved by lead'));
  assert.deepEqual(events.slice(-2), ['push', 'merge t827-ship-tool']);
});

test('with --merge on a head whose work commits differ from the approved head, each change is named and nothing is cleared or changed (T2913)', async () => {
  const changed = fake(rebased([workOf(HEAD_SHA, 'ship: a', 'pa2'), workOf('8888888888', 'docs: a', 'pd'), workOf('9999999999', 'core: b', 'pb')]));
  await assert.rejects(
    shipCommits({ ...ARGS, merge: true, approved: '61854f9e1' }, CHUNKS, changed.deps),
    /^Error: REFUSED the head 5efae2e91 is not the approved 61854f9e1 rebased: changed 61854f9e1 "ship: a", now 5efae2e91; added 999999999 "core: b"\. Ship it without --merge/,
  );
  assert.ok(!changed.events.some((event) => event.startsWith('clear ') || event.startsWith('take back')));

  const dropped = fake(rebased([workOf(HEAD_SHA, 'ship: a', 'pa')]));
  await assert.rejects(shipCommits({ ...ARGS, merge: true, approved: '61854f9e1' }, CHUNKS, dropped.deps), /: dropped 777777777 "docs: a"\./);
});

test('with --merge, an --approved that is neither the head nor a commit here is refused before anything changes (T2913)', async () => {
  const { deps, events } = fake({ gitFails: 'rev-parse --verify --quiet 61854f9e1^{commit}' });
  await assert.rejects(shipCommits({ ...ARGS, merge: true, approved: '61854f9e1' }, CHUNKS, deps), /^Error: REFUSED --approved 61854f9e1 is not the branch head 5efae2e91, nor a commit here to compare its work with$/);
  assert.equal(events.at(-1), 'git rev-parse --verify --quiet 61854f9e1^{commit}');
});

test('a refused clearance throws REFUSED before any take back, commit or push', async () => {
  const { deps, events } = fake({ clearance: { kind: 'refused', reason: 'T827 has no approval of 5efae2e91 by lead' } });
  await assert.rejects(shipCommits({ ...ARGS, merge: true }, CHUNKS, deps), /^Error: REFUSED T827 has no approval of 5efae2e91 by lead$/);
  assert.deepEqual(events, ['git rev-parse --abbrev-ref HEAD', 'git rev-parse HEAD', `clear t827-ship-tool ${HEAD_SHA} none`]);
});

test("a root team's lead clears itself: no fingerprint, and the merge goes on", async () => {
  const { deps, events, logs } = fake({ clearance: { kind: 'self' } });
  assert.equal(await shipCommits({ ...ARGS, merge: true }, CHUNKS, deps), 0);
  assert.ok(!events.some((event) => event.startsWith('patch ')));
  assert.deepEqual(events.slice(-2), ['push', 'merge t827-ship-tool']);
  assert.ok(logs.includes("merge of t827-ship-tool 5efae2e91: the caller's own, a root team's lead"));
});

test('a change that differs from the approved one by the push is refused before the push', async () => {
  const { deps, events } = fake({ patches: ['p1', 'p2'] });
  await assert.rejects(shipCommits({ ...ARGS, merge: true }, CHUNKS, deps), /^Error: REFUSED the change differs from the approved head 5efae2e91 outside the version files and dist/);
  assert.ok(!events.includes('push'));
  assert.deepEqual(events.filter((event) => event.startsWith('patch ')), [`patch ${HEAD_SHA}`, 'patch HEAD']);
});

test('without --merge, nothing is cleared or fingerprinted', async () => {
  const { deps, events } = fake();
  await shipCommits(ARGS, CHUNKS, deps);
  assert.ok(!events.some((event) => event.startsWith('clear ') || event.startsWith('patch ') || event === 'git rev-parse HEAD'));
});

const TIP = 'fedcba9876543210';
const MOVED: MergeExit = { kind: 'moved', tip: TIP, reason: 'main moved to fedcba9' };
const VERSION_AND_DIST = `plugins/teamrig/.claude-plugin/plugin.json\nsrc/core/version.ts\n${DIST}/a.js\n`;

/** git's answers for a move of main to TIP: the branch changed `ours` since it left main, main changed `theirs`. */
function moveAnswers(ours: string, theirs: string, taken: readonly string[] = []): Record<string, string> {
  const answers: Record<string, string> = {
    [`merge-base HEAD ${TIP}`]: 'base111\n',
    'diff --name-only --no-renames base111 HEAD': ours,
    [`diff --name-only --no-renames base111 ${TIP}`]: theirs,
    'rev-parse --abbrev-ref HEAD': 't827-ship-tool\n',
  };
  for (let n = 2; n <= 5; n++) {
    const name = `t827-ship-tool-${n}`;
    answers[`branch --list ${name}`] = taken.includes(`local ${name}`) ? `  ${name}\n` : '';
    answers[`ls-remote --heads origin refs/heads/${name}`] = taken.includes(`origin ${name}`) ? `abc\trefs/heads/${name}\n` : '';
  }
  return answers;
}

test('when main moved past the branch touching other files, renames the branch and ships again from the start (T2696)', async () => {
  const { deps, events, logs } = fake({
    mergeExits: [MOVED, { kind: 'done', code: 0 }],
    answers: moveAnswers(`src/a.ts\n${VERSION_AND_DIST}`, `src/other.ts\n${VERSION_AND_DIST}`),
  });
  assert.equal(await shipCommits({ ...ARGS, merge: true }, CHUNKS, deps), 0);
  const rename = events.indexOf('git branch -m t827-ship-tool-2');
  assert.ok(rename > events.indexOf('merge t827-ship-tool'));
  const again = events.slice(rename + 1);
  assert.deepEqual(again.slice(0, 6), [
    'hold head',
    'take back 2 chunk(s) since origin/main',
    'sync',
    'git status --porcelain -- src/a.ts',
    'git status --porcelain -- src/b.ts src/b.test.ts',
    'git add -- src/a.ts',
  ]);
  assert.deepEqual(again.slice(-2), ['push', 'merge t827-ship-tool']);
  assert.equal(events.filter((event) => event === 'sync').length, 2);
  assert.ok(logs.includes('\nmain moved to fedcba9, touching no file this change touches: shipping again as t827-ship-tool-2'));
});

test('the new branch name skips one taken here or on origin', async () => {
  const { deps, events } = fake({
    mergeExits: [MOVED, { kind: 'done', code: 0 }],
    answers: moveAnswers('src/a.ts\n', 'src/other.ts\n', ['local t827-ship-tool-2', 'origin t827-ship-tool-3']),
  });
  assert.equal(await shipCommits({ ...ARGS, merge: true }, CHUNKS, deps), 0);
  assert.deepEqual(events.filter((event) => event.startsWith('git branch -m')), ['git branch -m t827-ship-tool-4']);
});

test('a move of main that changed a file this change changes is refused, naming the files, with no second run', async () => {
  const { deps, events } = fake({
    mergeExits: [MOVED],
    answers: moveAnswers(`src/a.ts\nsrc/b.ts\n${VERSION_AND_DIST}`, `docs/x.md\nsrc/b.ts\nsrc/a.ts\n${VERSION_AND_DIST}`),
  });
  await assert.rejects(
    shipCommits({ ...ARGS, merge: true }, CHUNKS, deps),
    /^Error: REFUSED main moved to fedcba9 and changed src\/b\.ts, src\/a\.ts, which this change changes too: rebase onto origin\/main by hand, then ship again under a new branch name$/,
  );
  assert.ok(!events.some((event) => event.startsWith('git branch -m')));
  assert.equal(events.filter((event) => event.startsWith('merge ')).length, 1);
});

test(`gives up after ${SHIP_ATTEMPTS} runs when main keeps moving, keeping the first branch name as the stem`, async () => {
  const { deps, events } = fake({ mergeExits: [MOVED], answers: moveAnswers('src/a.ts\n', 'src/other.ts\n') });
  await assert.rejects(
    shipCommits({ ...ARGS, merge: true }, CHUNKS, deps),
    new RegExp(`^Error: REFUSED main moved past the branch ${SHIP_ATTEMPTS} times during this ship, last to fedcba9: ship again$`),
  );
  assert.equal(events.filter((event) => event.startsWith('merge ')).length, SHIP_ATTEMPTS);
  assert.equal(events.filter((event) => event.startsWith('git branch -m')).length, SHIP_ATTEMPTS - 1);
  assert.equal(events.filter((event) => event === 'git rev-parse --abbrev-ref HEAD').length, 1);
});

const FAILED_GATE: GateVerdict = { passed: false, reason: 'plugin version gate failed on tree tree000' };

test('with --merge, local checks that fail on a branch main moved past ship again on the moved main (T2725)', async () => {
  const { deps, events, logs } = fake({
    verdict: FAILED_GATE,
    moves: [{ tip: TIP, reason: 'origin/main moved to fedcba9, which the branch does not contain' }, null],
    answers: moveAnswers(`src/a.ts\n${VERSION_AND_DIST}`, `src/other.ts\n${VERSION_AND_DIST}`),
  });
  await assert.rejects(shipCommits({ ...ARGS, merge: true }, CHUNKS, deps), /^Error: REFUSED plugin version gate failed on tree tree000$/);
  assert.ok(logs.includes('\nlocal checks: plugin version gate failed on tree tree000, and origin/main moved to fedcba9, which the branch does not contain'));
  const rename = events.indexOf('git branch -m t827-ship-tool-2');
  assert.ok(rename > events.indexOf('look at main'));
  assert.equal(events.filter((event) => event === 'sync').length, 2);
  assert.equal(events.filter((event) => event === 'look at main').length, 2);
  assert.ok(!events.includes('push'));
});

test('local checks that fail on a branch main has not moved past, or without --merge, are refused at once', async () => {
  const unmoved = fake({ verdict: FAILED_GATE });
  await assert.rejects(shipCommits({ ...ARGS, merge: true }, CHUNKS, unmoved.deps), /^Error: REFUSED plugin version gate failed/);
  assert.equal(unmoved.events.filter((event) => event === 'sync').length, 1);
  const unmerged = fake({ verdict: FAILED_GATE, moves: [{ tip: TIP, reason: 'moved' }] });
  await assert.rejects(shipCommits(ARGS, CHUNKS, unmerged.deps), /^Error: REFUSED plugin version gate failed/);
  assert.ok(!unmerged.events.includes('look at main'));
});

test('parseNumstat reads counts, keeps a binary file uncounted and a path with a tab whole', () => {
  assert.deepEqual(parseNumstat(`3\t1\t${DIST}/a.js\n-\t-\t${DIST}/icon.png\n2\t0\t${DIST}/odd\tname.js\n`), [
    { path: `${DIST}/a.js`, added: 3, deleted: 1 },
    { path: `${DIST}/icon.png`, added: null, deleted: null },
    { path: `${DIST}/odd\tname.js`, added: 2, deleted: 0 },
  ]);
  assert.deepEqual(parseNumstat(''), []);
});

test('weighDist holds the dist to the default size rule: over 400 lines or over 15 files', () => {
  assert.deepEqual(weighDist(parseNumstat(`200\t200\t${DIST}/a.js`)), { lines: 400, files: 1, large: false });
  assert.equal(weighDist(parseNumstat(`201\t200\t${DIST}/a.js`)).large, true);
  const files = (count: number): string => Array.from({ length: count }, (_, index) => `1\t0\t${DIST}/f${index}.js`).join('\n');
  assert.equal(weighDist(parseNumstat(files(15))).large, false);
  assert.equal(weighDist(parseNumstat(files(16))).large, true);
});

test('raisePathsOf: only path stamps join the raise, so a raise chunk that also edits Markdown stays work (#1411)', () => {
  const raise = raisePathsOf(TEAMRIG_VERSION_FILES, TEAMRIG_RELEASE_STAMPS);
  assert.deepEqual(raise.stamps, ['src/config/migrate.ts']);
  const [version] = TEAMRIG_VERSION_FILES;
  assert.ok(version !== undefined);
  assert.equal(isRaiseOnly({ files: [version.path, 'src/config/migrate.ts'], subject: 'plugin: version', body: '' }, raise), true);
  for (const docs of ['README.md', 'docs/commands.md', 'plugins/teamrig/config.schema.json']) {
    assert.equal(isRaiseOnly({ files: [version.path, docs], subject: 'plugin: version', body: '' }, raise), false, docs);
  }
});
