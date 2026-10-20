import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type CheckCommandDeps, type CheckRun, type GateDeps, SHIP_RAN_BEFORE, SKILL_DIR, checkCommand, checksFor, commandOf, parseRecord, proveTree, realGateDeps, recordPath } from './local-gate.ts';
import { type LocalChecks, parseProfiles } from './repos.ts';

const DIR = 'C:/repo';
const TREE = 'tree000aaa';
const COMMIT = 'commit0bbb';
const RECORD = join('C:/repo/.git', 'local-ci', `${TREE}.json`);
const CHECKS: LocalChecks = {
  runner: 'tools/ci/local.ts',
  fallback: [
    { name: 'lint', run: ['node', 'lint.ts'], cwd: null },
    { name: 'typecheck', run: ['node', 'tsc.js'], cwd: null },
    { name: 'sync', run: ['node', 'sync.ts'], cwd: 'plugins/x' },
  ],
};
const VALID = (tree = TREE): string => JSON.stringify({ tree, commit: COMMIT, checks: ['lint'], passedAt: '2026-10-15T09:00:00.000Z', node: 'v22.19.0' });

interface GateFixture {
  /** `git status --porcelain` before the checks, then after them. */
  status?: readonly [string, string];
  /** The tree HEAD holds before the checks, then after them. */
  trees?: readonly [string, string];
  /** What the record file holds before the checks, then after them (a runner writes its own). */
  records?: readonly [string | null, string | null];
  runner?: boolean;
  /** Exit codes by check name; 0 when not listed. */
  exits?: Readonly<Record<string, number | null>>;
}

function fakeGate(fixture: GateFixture = {}): { deps: GateDeps; runs: string[]; written: [string, string][]; log: string[] } {
  const runs: string[] = [];
  const written: [string, string][] = [];
  const log: string[] = [];
  const reads = { status: 0, tree: 0, record: 0 };
  const pick = <T>(pair: readonly [T, T], key: keyof typeof reads): T => pair[Math.min(reads[key]++, 1)] ?? pair[0];
  const deps: GateDeps = {
    git: (...args) => {
      const key = args.join(' ');
      if (key === 'status --porcelain') return pick(fixture.status ?? ['', ''], 'status');
      if (key === 'rev-parse HEAD^{tree}') return pick(fixture.trees ?? [TREE, TREE], 'tree');
      if (key === 'rev-parse HEAD') return COMMIT;
      if (key === 'rev-parse --git-common-dir') return 'C:/repo/.git';
      throw new Error(`unexpected git ${key}`);
    },
    exists: path => fixture.runner === true && path === join(DIR, 'tools/ci/local.ts'),
    readText: path => (path === RECORD ? pick(fixture.records ?? [null, null], 'record') : null),
    writeText: (path, text) => written.push([path, text]),
    run: (check): CheckRun => {
      runs.push(check.name);
      const exits = fixture.exits ?? {};
      const status = Object.hasOwn(exits, check.name) ? (exits[check.name] ?? null) : 0;
      return { status, output: `${check.name} says hi\n`, ms: 1500 };
    },
    now: () => new Date('2026-10-15T10:00:00Z'),
    log: line => log.push(line),
  };
  return { deps, runs, written, log };
}

test('runs every check in order, then writes a pass record for the tree in the shared git folder', () => {
  const { deps, runs, written, log } = fakeGate();
  assert.deepEqual(proveTree(DIR, CHECKS, deps), { passed: true, tree: TREE, record: RECORD, reused: false });
  assert.deepEqual(runs, ['lint', 'typecheck', 'sync']);
  assert.deepEqual(log.slice(0, 3), ['pass: lint (2s)', 'pass: typecheck (2s)', 'pass: sync (2s)']);
  assert.equal(log.at(-1), `local checks: 3 passed on tree tree000, recorded in ${RECORD}`);
  assert.equal(written.length, 1);
  const [path, text] = written[0] ?? ['', ''];
  assert.equal(path, RECORD);
  assert.deepEqual(JSON.parse(text), { tree: TREE, commit: COMMIT, checks: ['lint', 'typecheck', 'sync'], passedAt: '2026-10-15T10:00:00.000Z', node: process.version });
  assert.deepEqual(parseRecord(text, TREE)?.checks, ['lint', 'typecheck', 'sync']);
});

test('a pass record for the tree skips every check', () => {
  const { deps, runs, written, log } = fakeGate({ records: [VALID(), VALID()] });
  assert.deepEqual(proveTree(DIR, CHECKS, deps), { passed: true, tree: TREE, record: RECORD, reused: true });
  assert.deepEqual(runs, []);
  assert.deepEqual(written, []);
  assert.deepEqual(log, ['local checks: passed earlier on tree tree000 (commit commit0, 2026-10-15T09:00:00.000Z, 1 check(s)), skipped']);
});

test('refuses uncommitted changes before running anything, naming the first few', () => {
  const { deps, runs } = fakeGate({ status: [' M a.ts\n M b.ts\n?? c.ts\n?? d.ts', ''] });
  const verdict = proveTree(DIR, CHECKS, deps);
  assert.deepEqual(verdict, { passed: false, reason: 'C:/repo has uncommitted changes ( M a.ts;  M b.ts; ?? c.ts; and 1 more): commit or stash them, the checks prove only a committed tree' });
  assert.deepEqual(runs, []);
});

test('stops at the first failed check, logs its full output, and records nothing', () => {
  const { deps, runs, written, log } = fakeGate({ exits: { typecheck: 2 } });
  assert.deepEqual(proveTree(DIR, CHECKS, deps), { passed: false, reason: 'typecheck failed on tree tree000' });
  assert.deepEqual(runs, ['lint', 'typecheck']);
  assert.deepEqual(log.slice(1), ['FAIL: typecheck (exit 2, 2s)', 'typecheck says hi']);
  assert.deepEqual(written, []);
  const killed = fakeGate({ exits: { lint: null } });
  proveTree(DIR, CHECKS, killed.deps);
  assert.equal(killed.log[0], 'FAIL: lint (exit none: it did not start or was killed, 2s)');
});

test('refuses a tree the checks changed, so a stale generated file never passes', () => {
  const dirty = fakeGate({ status: ['', ' M dist/a.js'] });
  assert.deepEqual(proveTree(DIR, CHECKS, dirty.deps), { passed: false, reason: 'the checks left C:/repo changed ( M dist/a.js): a generated file differs from the committed one' });
  assert.deepEqual(dirty.written, []);
  const moved = fakeGate({ trees: [TREE, 'tree999zzz'] });
  assert.deepEqual(proveTree(DIR, CHECKS, moved.deps), { passed: false, reason: 'the checks left C:/repo changed (HEAD now holds tree tree999): a generated file differs from the committed one' });
});

test('skips the checks named as already run on this content, and ship names its own', () => {
  const { deps, runs, log, written } = fakeGate();
  assert.equal(proveTree(DIR, CHECKS, deps, ['typecheck']).passed, true);
  assert.deepEqual(runs, ['lint', 'sync']);
  assert.equal(log[1], 'pass: typecheck (before the commits, on this content)');
  assert.deepEqual(JSON.parse(written[0]?.[1] ?? '{}').checks, ['lint', 'typecheck', 'sync']);
  assert.deepEqual(SHIP_RAN_BEFORE, ['typecheck', 'coverage gate', 'build: clean', 'build: compile']);
});

test('a tree that holds the repo runner runs it alone, and keeps the record the runner wrote', () => {
  const { deps, runs, written, log } = fakeGate({ runner: true, records: [null, VALID()] });
  assert.equal(proveTree(DIR, CHECKS, deps).passed, true);
  assert.deepEqual(runs, ['runner tools/ci/local.ts']);
  assert.deepEqual(written, []);
  assert.equal(log.at(-1), `local checks: 1 passed on tree tree000, recorded in ${RECORD}`);
  assert.deepEqual(checksFor(DIR, CHECKS, () => true), [{ name: 'runner tools/ci/local.ts', run: ['node', 'tools/ci/local.ts'], cwd: null }]);
  assert.equal(checksFor(DIR, { runner: null, fallback: CHECKS.fallback }, () => true), CHECKS.fallback);
});

test('refuses to prove a tree with no checks to run', () => {
  const { deps } = fakeGate();
  assert.deepEqual(proveTree(DIR, { runner: null, fallback: [] }, deps), { passed: false, reason: 'no local checks are listed for this repo in repos.json: nothing would prove the tree' });
});

test('reads a record only when it is one, for this tree', () => {
  assert.equal(parseRecord(null, TREE), null);
  assert.equal(parseRecord('not json', TREE), null);
  assert.equal(parseRecord('[]', TREE), null);
  assert.equal(parseRecord(VALID('other'), TREE), null);
  assert.equal(parseRecord(JSON.stringify({ tree: TREE, commit: COMMIT, checks: [1], passedAt: 'x', node: 'v' }), TREE), null);
  assert.equal(parseRecord(JSON.stringify({ tree: TREE, commit: COMMIT, checks: [], passedAt: 'x' }), TREE), null);
  assert.deepEqual(parseRecord(VALID(), TREE), { tree: TREE, commit: COMMIT, checks: ['lint'], passedAt: '2026-10-15T09:00:00.000Z', node: 'v22.19.0' });
});

test('puts the record in the git folder every worktree shares, whether git names it absolute or relative', () => {
  assert.equal(recordPath(DIR, 'C:/work/r/.git', TREE), join('C:/work/r/.git', 'local-ci', `${TREE}.json`));
  assert.equal(recordPath(DIR, '.git', TREE), join(DIR, '.git', 'local-ci', `${TREE}.json`));
});

test('spawns a leading node as this node without the experimental warning, and fills in the skill folder', () => {
  assert.deepEqual(commandOf(['node', '{skill}/size-rule.ts', '--base', 'origin/main'], 'C:/skill', 'C:/node.exe'), { file: 'C:/node.exe', args: ['--disable-warning=ExperimentalWarning', 'C:/skill/size-rule.ts', '--base', 'origin/main'] });
  assert.deepEqual(commandOf(['git', 'status'], 'C:/skill', 'C:/node.exe'), { file: 'git', args: ['status'] });
  assert.equal(commandOf(['node', '{skill}']).args[1], SKILL_DIR);
});

function checkFixture(answers: Readonly<Record<string, string>>, exit = 0): { deps: CheckCommandDeps; err: string[]; log: string[] } {
  const gate = fakeGate({ exits: { lint: exit } });
  const err: string[] = [];
  const git = gate.deps.git;
  return {
    deps: {
      profiles: parseProfiles('{"Owner/repo":{"main":"main","gate":"ci","checks":["a"],"local":{"fallback":[{"name":"lint","run":["node","lint.ts"]}]}}}'),
      gate: { ...gate.deps, git: (...args) => answers[args.join(' ')] ?? git(...args) },
      err: line => err.push(line),
    },
    err,
    log: gate.log,
  };
}

test('ship.ts check proves the dir with its repo\'s local checks, whatever its merge gate', t => {
  const origin = { 'remote get-url origin': 'git@github.com:Owner/repo.git' };
  const passed = checkFixture(origin);
  assert.equal(checkCommand([DIR], dir => (dir === DIR ? passed.deps : checkFixture({}).deps)), 0);
  assert.equal(passed.log[0], 'pass: lint (2s)');

  const failed = checkFixture(origin, 1);
  assert.equal(checkCommand([DIR], () => failed.deps), 1);
  assert.deepEqual(failed.err, ['REFUSED lint failed on tree tree000']);

  const unknown = checkFixture({ 'remote get-url origin': 'git@github.com:Owner/other.git' });
  assert.equal(checkCommand([DIR], () => unknown.deps), 1);
  assert.match(unknown.err[0] ?? '', /no check list for Owner\/other/);

  const consoleError = t.mock.method(console, 'error', () => undefined);
  for (const argv of [[], ['--all'], [DIR, 'extra']]) assert.equal(checkCommand(argv, () => passed.deps), 1);
  assert.deepEqual(consoleError.mock.calls.map(call => call.arguments[0]), Array(3).fill('usage: ship.ts check <repo dir>'));
});

test('the real gate proves a committed tree in a git repo once, then reuses its record', t => {
  const dir = mkdtempSync(join(tmpdir(), 'local-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'a');
  const log: string[] = [];
  const deps = realGateDeps(dir, line => log.push(line));
  const checks: LocalChecks = { runner: 'missing-runner.ts', fallback: [{ name: 'reads a', run: ['node', '-e', "process.exit(require('node:fs').readFileSync('a.txt', 'utf8') === 'a\\n' ? 0 : 5)"], cwd: null }] };
  const first = proveTree(dir, checks, deps);
  assert.equal(first.passed, true, log.join('\n'));
  const record = first.passed ? first.record : '';
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).tree, git('rev-parse', 'HEAD^{tree}'));
  assert.deepEqual(proveTree(dir, checks, deps), { passed: true, tree: git('rev-parse', 'HEAD^{tree}'), record, reused: true });

  const failing = deps.run({ name: 'fails', run: ['node', '-e', "console.log('out'); console.error('err'); process.exit(3)"], cwd: null });
  assert.equal(failing.status, 3);
  assert.equal(failing.output, 'out\n\nerr\n');
  const missing = deps.run({ name: 'missing', run: ['no-such-command-here'], cwd: null });
  assert.equal(missing.status, null);
  assert.match(missing.output, /ENOENT/);
});

test('ship.ts check with the real deps reads the shipped repos.json and the dir\'s origin', t => {
  const dir = mkdtempSync(join(tmpdir(), 'local-gate-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:Owner/not-listed.git']);
  const consoleError = t.mock.method(console, 'error', () => undefined);
  assert.equal(checkCommand([dir]), 1);
  assert.match(String(consoleError.mock.calls[0]?.arguments[0]), /no check list for Owner\/not-listed/);
});
