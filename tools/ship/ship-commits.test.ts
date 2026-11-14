import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GateVerdict } from './local-gate.ts';
import type { MainMove, MergeExit } from './merge.ts';
import { DIST, parseNumstat, SHIP_ATTEMPTS, shipCommits, weighDist, type ShipDeps } from './ship-commits.ts';
import type { Chunk, ShipArgs } from './ship-plan.ts';
import type { SyncResult } from './sync.ts';

const ARGS: ShipArgs = { repo: 'C:/repo', plan: 'plan.json', base: 'origin/main', merge: false, noteFile: null };
const CHUNKS: readonly Chunk[] = [
  { files: ['src/a.ts'], subject: 'core: a', body: 'why a' },
  { files: ['src/b.ts', 'src/b.test.ts'], subject: 'release: 0.134.0', body: 'raises 0.134.0' },
];
const PASS: GateVerdict = { passed: true, tree: 'tree000', record: 'C:/records/tree000.json', reused: false };
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const TSC = 'node node_modules/typescript/bin/tsc -p tsconfig.json';

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
}

interface Fake {
  readonly deps: ShipDeps;
  /** Every command, git call, gate run, push and merge, in order. */
  readonly events: string[];
  readonly logs: string[];
}

function fake(options: FakeOptions = {}): Fake {
  const events: string[] = [];
  const logs: string[] = [];
  let merges = 0;
  let looks = 0;
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
      const answer = options.answers?.[joined];
      if (answer !== undefined) return answer;
      return args[0] === 'diff' ? (options.numstat ?? '') : 'abc1234 core: a\n';
    },
    log: (line) => logs.push(line),
    takeBack: (chunks, base) => {
      events.push(`take back ${chunks.length} chunk(s) since ${base}`);
    },
    sync: () => {
      events.push('sync');
      return options.sync ?? { kind: 'current', sets: '0.134.0' };
    },
    buildSteps: () => [['tools/build/bundle.ts']],
    proveTree: () => {
      events.push('prove');
      return options.verdict ?? PASS;
    },
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
  };
  return { deps, events, logs };
}

const committed = (subject: string, body: string, ...extra: string[]): string =>
  ['git commit -q -s -m', subject, '-m', body, ...extra.flatMap((line) => ['-m', line]), '-m', TRAILER].join(' ');

test('takes back an earlier run first, then syncs, typechecks, runs the coverage gate, commits each chunk, builds and proves the tree, and stops there without --merge', async () => {
  const { deps, events } = fake();
  assert.equal(await shipCommits(ARGS, CHUNKS, deps), 0);
  assert.deepEqual(events, [
    'take back 2 chunk(s) since origin/main',
    'sync',
    TSC,
    'node tools/ci/coverage-cli.ts',
    'git add -- src/a.ts',
    committed('core: a', 'why a'),
    'git add -- src/b.ts src/b.test.ts',
    committed('release: 0.134.0', 'raises 0.134.0'),
    'node tools/build/bundle.ts',
    `git add -- ${DIST}`,
    'git diff --cached --numstat',
    'prove',
    'git log --oneline origin/main..HEAD',
  ]);
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
const RAISING: readonly Chunk[] = [
  { files: ['src/a.ts'], subject: 'core: a', body: 'why a, since 0.134.0' },
  { files: ['plugins/teamrig/.claude-plugin/plugin.json', 'src/core/version.ts'], subject: 'plugin: version 0.134.0, a', body: 'raises 0.134.0' },
];

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

test('a failed typecheck or coverage gate stops before any commit', async () => {
  for (const failOn of [TSC, 'node tools/ci/coverage-cli.ts']) {
    const { deps, events } = fake({ failOn });
    await assert.rejects(shipCommits(ARGS, CHUNKS, deps), new RegExp(`^Error: ${failOn} failed$`));
    assert.ok(!events.some((event) => event.startsWith('git ')), failOn);
  }
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
  assert.deepEqual(events.slice(-3), ['git log --oneline origin/main..HEAD', 'push', 'merge t827-ship-tool']);
  assert.ok(logs.includes('\npushed t827-ship-tool; merging:'));
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
  assert.deepEqual(again.slice(0, 3), ['take back 2 chunk(s) since origin/main', 'sync', TSC]);
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
