import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Git } from '../lib/git.ts';
import { TempRepo } from '../lib/temp-repo.ts';
import {
  type CheckRun,
  type GateDeps,
  type LocalCheck,
  type PushUpdate,
  checkEnv,
  isolatedEnv,
  machineDeps,
  parsePushUpdates,
  parseRecord,
  proveHead,
  provePush,
  recordPath,
  spawnChecks,
  writeTextFile,
} from './local-gate.ts';

const TREE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const OTHER_TREE = 'd'.repeat(40);
const ROOT = resolve('work', 'repo');
const PATH = recordPath(ROOT, '.git', TREE);
const OTHER_PATH = recordPath(ROOT, '.git', OTHER_TREE);
const CHECKS: readonly LocalCheck[] = [
  { name: 'lint', argv: ['node', 'lint.ts'] },
  { name: 'test', argv: ['node', 'test.ts'] },
];
const NOW = new Date('2026-10-15T10:00:00Z');

/** A git that answers from a script per argument list, in order; the last answer repeats. */
class ScriptedGit implements Git {
  readonly calls: string[] = [];
  private readonly answers: Map<string, string[]>;

  constructor(answers: Readonly<Record<string, readonly string[]>>) {
    this.answers = new Map(Object.entries(answers).map(([key, list]) => [key, [...list]]));
  }

  async text(args: readonly string[]): Promise<string> {
    const key = args.join(' ');
    this.calls.push(key);
    const list = this.answers.get(key);
    const answer = list === undefined ? undefined : list.length > 1 ? list.shift() : list[0];
    if (answer === undefined) throw new Error(`unexpected git ${key}`);
    return answer;
  }

  async bytes(args: readonly string[]): Promise<Buffer> {
    throw new Error(`unexpected git bytes ${args.join(' ')}`);
  }
}

interface Fixture {
  readonly deps: GateDeps;
  readonly git: ScriptedGit;
  readonly out: string[];
  readonly runs: string[];
  readonly files: Map<string, string>;
}

function fixture(options: { git?: Readonly<Record<string, readonly string[]>>; results?: Readonly<Record<string, CheckRun>>; files?: Readonly<Record<string, string>> } = {}): Fixture {
  const git = new ScriptedGit({
    'status --porcelain': [''],
    'rev-parse HEAD^{tree}': [TREE],
    'rev-parse HEAD': [HEAD],
    'rev-parse --git-common-dir': ['.git\n'],
    ...options.git,
  });
  const out: string[] = [];
  const runs: string[] = [];
  const files = new Map(Object.entries(options.files ?? {}));
  const deps: GateDeps = {
    git,
    root: ROOT,
    run: (check) => {
      runs.push(check.name);
      return options.results?.[check.name] ?? { status: 0, output: `${check.name} ok\n`, ms: 1500 };
    },
    readText: (path) => files.get(path),
    writeText: (path, text) => {
      files.set(path, text);
    },
    now: () => NOW,
    node: 'v22.0.0',
    out: (line) => out.push(line),
  };
  return { deps, git, out, runs, files };
}

const record = (tree: string, commit = HEAD): string => JSON.stringify({ tree, commit, checks: ['lint', 'test'], passedAt: NOW.toISOString(), node: 'v22.0.0' });

describe('proveHead', () => {
  it('runs every check in order, then records the pass for the tree in the git common dir', async () => {
    const { deps, out, runs, files } = fixture();
    assert.deepEqual(await proveHead(CHECKS, deps), { passed: true });
    assert.deepEqual(runs, ['lint', 'test']);
    assert.deepEqual(out, ['pass: lint (2s)', 'pass: test (2s)', `local checks: 2 passed on tree aaaaaaa, recorded in ${PATH}`]);
    assert.equal(files.get(PATH), `${JSON.stringify({ tree: TREE, commit: HEAD, checks: ['lint', 'test'], passedAt: '2026-10-15T10:00:00.000Z', node: 'v22.0.0' }, null, 2)}\n`);
    assert.equal(PATH, join(ROOT, '.git', 'local-ci', `${TREE}.json`));
  });

  it('reuses the pass record of the tree and runs nothing', async () => {
    const { deps, out, runs } = fixture({ files: { [PATH]: record(TREE, OTHER) } });
    assert.deepEqual(await proveHead(CHECKS, deps), { passed: true });
    assert.deepEqual(runs, []);
    assert.deepEqual(out, ['local checks: passed earlier on tree aaaaaaa (commit ccccccc, 2026-10-15T10:00:00.000Z, 2 check(s))']);
  });

  it('stops at the first failing check, prints its output and records nothing', async () => {
    const { deps, out, runs, files } = fixture({ results: { lint: { status: 3, output: 'lint: 1 problem\n', ms: 400 } } });
    assert.deepEqual(await proveHead(CHECKS, deps), { passed: false, reason: 'lint failed on tree aaaaaaa' });
    assert.deepEqual(runs, ['lint']);
    assert.deepEqual(out, ['FAIL: lint (exit 3, 0s)', 'lint: 1 problem']);
    assert.equal(files.size, 0);

    const killed = fixture({ results: { test: { status: null, output: '', ms: 2600 } } });
    assert.deepEqual(await proveHead(CHECKS, killed.deps), { passed: false, reason: 'test failed on tree aaaaaaa' });
    assert.deepEqual(killed.out.slice(1), ['FAIL: test (exit none: it did not start or was killed, 3s)', '']);
  });

  it('refuses uncommitted changes, untracked files included, before any check', async () => {
    const { deps, runs } = fixture({ git: { 'status --porcelain': [' M a.ts\n?? b.ts\n'] } });
    const verdict = await proveHead(CHECKS, deps);
    assert.deepEqual(verdict, { passed: false, reason: 'the checkout has uncommitted changes (M a.ts; ?? b.ts): commit or stash them, the checks prove a committed tree' });
    assert.deepEqual(runs, []);
  });

  it('refuses when the checks changed a file or the commit, and records nothing', async () => {
    const dirty = fixture({ git: { 'status --porcelain': ['', ' M dist/a.js\n'] } });
    const changed = await proveHead(CHECKS, dirty.deps);
    assert.equal(changed.passed, false);
    assert.match(changed.passed ? '' : changed.reason, /^the checks left the checkout changed \(M dist\/a\.js\): a generated file differs/);
    assert.equal(dirty.files.size, 0);

    const moved = fixture({ git: { 'rev-parse HEAD^{tree}': [TREE, OTHER_TREE] } });
    const verdict = await proveHead(CHECKS, moved.deps);
    assert.match(verdict.passed ? '' : verdict.reason, /left the checkout changed \(HEAD now holds tree ddddddd\)/);
    assert.equal(moved.files.size, 0);
  });

  it('refuses an empty list of checks', async () => {
    assert.deepEqual(await proveHead([], fixture().deps), { passed: false, reason: 'no checks are listed: nothing would prove the tree' });
  });
});

describe('parseRecord', () => {
  it('reads a record for the tree and ignores a missing, broken or foreign one', () => {
    assert.deepEqual(parseRecord(record(TREE), TREE), { tree: TREE, commit: HEAD, checks: ['lint', 'test'], passedAt: NOW.toISOString(), node: 'v22.0.0' });
    const fields = { tree: TREE, commit: HEAD, checks: ['lint'], passedAt: 'x', node: 'v22' };
    for (const text of [
      undefined,
      '{',
      '[]',
      record(OTHER_TREE),
      JSON.stringify({ ...fields, commit: 1 }),
      JSON.stringify({ ...fields, passedAt: null }),
      JSON.stringify({ ...fields, node: undefined }),
      JSON.stringify({ ...fields, checks: 'lint' }),
      JSON.stringify({ ...fields, checks: ['lint', 2] }),
    ]) {
      assert.equal(parseRecord(text, TREE), undefined, String(text));
    }
  });

  it('keeps an absolute git common dir, as a worktree reports it', () => {
    const common = resolve('elsewhere', '.git');
    assert.equal(recordPath(ROOT, common, TREE), join(common, 'local-ci', `${TREE}.json`));
  });
});

describe('provePush', () => {
  const push = (localSha: string, localRef = 'refs/heads/topic'): PushUpdate => ({ localRef, localSha, remoteRef: 'refs/heads/topic' });

  it('passes a push with nothing to send, and a deletion, without running a check', async () => {
    const empty = fixture();
    assert.deepEqual(await provePush([], CHECKS, empty.deps), { passed: true });
    assert.deepEqual(empty.out, ['local checks: nothing to push']);
    assert.deepEqual(empty.git.calls, []);

    const deletion = fixture();
    assert.deepEqual(await provePush([push('0'.repeat(40))], CHECKS, deletion.deps), { passed: true });
    assert.deepEqual(deletion.out, ['local checks: refs/heads/topic is deleted, nothing to check']);
    assert.deepEqual(deletion.runs, []);
  });

  it('passes a commit whose tree passed earlier, checked out or not', async () => {
    const { deps, out, runs } = fixture({ git: { [`rev-parse ${OTHER}^{tree}`]: [OTHER_TREE] }, files: { [OTHER_PATH]: record(OTHER_TREE) } });
    assert.deepEqual(await provePush([push(OTHER)], CHECKS, deps), { passed: true });
    assert.deepEqual(out, ['local checks: refs/heads/topic (tree ddddddd) passed earlier (2026-10-15T10:00:00.000Z, 2 check(s))']);
    assert.deepEqual(runs, []);
  });

  it('refuses a commit with no record that is not checked out', async () => {
    const { deps, runs } = fixture({ git: { [`rev-parse ${OTHER}^{tree}`]: [OTHER_TREE] } });
    assert.deepEqual(await provePush([push(OTHER, 'refs/heads/other')], CHECKS, deps), {
      passed: false,
      reason: 'refs/heads/other is at ccccccc, but the checkout has bbbbbbb and the checks run on the checkout: check out refs/heads/other and push again',
    });
    assert.deepEqual(runs, []);
  });

  it('refuses an update or a deletion of main before any git call or check', async () => {
    const reason = 'refs/heads/main changes only through a pull request: push a branch of your own and open a pull request from it';
    for (const localSha of [HEAD, '0'.repeat(40)]) {
      const { deps, git, runs } = fixture({ git: { [`rev-parse ${HEAD}^{tree}`]: [TREE] } });
      const toMain: PushUpdate = { localRef: 'refs/heads/topic', localSha, remoteRef: 'refs/heads/main' };
      assert.deepEqual(await provePush([push(HEAD), toMain], CHECKS, deps), { passed: false, reason });
      assert.deepEqual([git.calls, runs], [[], []]);
    }
  });

  it('runs the checks on the checked-out commit and stops on a failure', async () => {
    const passing = fixture({ git: { [`rev-parse ${HEAD}^{tree}`]: [TREE] } });
    assert.deepEqual(await provePush([push(HEAD), push(HEAD, 'refs/heads/again')], CHECKS, passing.deps), { passed: true });
    assert.deepEqual(passing.runs, ['lint', 'test'], 'the second update reuses the record the first wrote');
    assert.ok(passing.files.has(PATH));

    const failing = fixture({ git: { [`rev-parse ${HEAD}^{tree}`]: [TREE] }, results: { test: { status: 1, output: 'boom', ms: 1 } } });
    assert.deepEqual(await provePush([push(HEAD)], CHECKS, failing.deps), { passed: false, reason: 'test failed on tree aaaaaaa' });
  });
});

describe('parsePushUpdates', () => {
  it('reads each line git gives the hook and refuses one it does not expect', () => {
    assert.deepEqual(parsePushUpdates(`refs/heads/a ${HEAD} refs/heads/a ${OTHER}\n\nrefs/heads/b ${OTHER} refs/heads/c ${'0'.repeat(40)}\n`), [
      { localRef: 'refs/heads/a', localSha: HEAD, remoteRef: 'refs/heads/a' },
      { localRef: 'refs/heads/b', localSha: OTHER, remoteRef: 'refs/heads/c' },
    ]);
    assert.deepEqual(parsePushUpdates(''), []);
    assert.throws(() => parsePushUpdates('refs/heads/a b'), /^Error: pre-push: unexpected line from git: refs\/heads\/a b$/);
  });
});

describe('check environments', () => {
  it('drops the variables a git hook sets, whatever their case, and the test runner context', () => {
    assert.deepEqual(checkEnv({ PATH: 'p', GIT_DIR: '.git', git_index_file: 'i', GITHUB_TOKEN: 't', NODE_TEST_CONTEXT: 'child' }), { PATH: 'p', GITHUB_TOKEN: 't' });
  });

  it('points the home and the Claude config folder at an empty folder', () => {
    assert.deepEqual(isolatedEnv({ PATH: 'p', HOME: 'h' }, 'T'), { PATH: 'p', HOME: 'T', USERPROFILE: 'T', CLAUDE_CONFIG_DIR: join('T', '.claude') });
  });
});

describe('spawnChecks', () => {
  /** A temp root with a `sub` folder; removed after the callback. */
  function withRoot(body: (root: string) => void): void {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'teamrig-local-gate-')));
    try {
      mkdirSync(join(root, 'sub'));
      body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('runs node from the root with the given environment, capturing stdout, stderr and the exit code', () => {
    withRoot((root) => {
      const run = spawnChecks(root, { ...process.env, LOCAL_GATE_TEST: 'yes' });
      const result = run({ name: 'n', argv: ['node', '-e', "process.stdout.write(process.cwd() + ' ' + process.env.LOCAL_GATE_TEST + ' ');process.stderr.write('err');process.exit(3)"] });
      assert.deepEqual({ status: result.status, output: result.output }, { status: 3, output: `${root} yes err` });
      assert.ok(result.ms >= 0);
      const sub = run({ name: 'n', argv: ['node', '-e', 'process.stdout.write(process.cwd())'], cwd: 'sub' });
      assert.deepEqual({ status: sub.status, output: sub.output }, { status: 0, output: join(root, 'sub') });
    });
  });

  it('reports a program that does not start as no exit code', () => {
    withRoot((root) => {
      const result = spawnChecks(root, process.env)({ name: 'n', argv: ['teamrig-no-such-program'] });
      assert.equal(result.status, null);
      assert.match(result.output, /^teamrig-no-such-program did not start: /);
    });
  });

  it('gives an isolated check an empty home with a config folder, and removes it after', () => {
    withRoot((root) => {
      const result = spawnChecks(root, process.env)({
        name: 'n',
        argv: ['node', '-e', "const fs = require('node:fs'); process.stdout.write(JSON.stringify([process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, fs.existsSync(process.env.CLAUDE_CONFIG_DIR)]))"],
        isolatedHome: true,
      });
      const seen: unknown = JSON.parse(result.output);
      assert.ok(Array.isArray(seen));
      const [home, profile, config, existed] = seen;
      assert.equal(typeof home, 'string');
      assert.deepEqual([profile, config, existed], [home, join(String(home), '.claude'), true]);
      assert.notEqual(home, process.env['HOME']);
      assert.equal(existsSync(String(home)), false, 'the home is removed after the run');
    });
  });
});

describe('machineDeps', () => {
  it('proves a committed tree with git, files and child processes, then reuses the record', async () => {
    const repo = new TempRepo('local-gate').init();
    try {
      repo.write('a.txt', 'a\n');
      repo.git('add', '-A');
      repo.git('commit', '-q', '-m', 'a');
      const tree = repo.git('rev-parse', 'HEAD^{tree}').trim();
      const out: string[] = [];
      const deps = machineDeps(repo.dir, process.env, (line) => out.push(line));
      assert.equal(deps.node, process.version);
      assert.ok(deps.now() instanceof Date);
      const check: LocalCheck = { name: 'ok', argv: ['node', '-e', ''] };
      assert.deepEqual(await proveHead([check], deps), { passed: true });
      const path = join(repo.dir, '.git', 'local-ci', `${tree}.json`);
      assert.deepEqual(parseRecord(deps.readText(path), tree)?.checks, ['ok']);
      assert.deepEqual(await proveHead([check], deps), { passed: true });
      assert.match(out.at(-1) ?? '', /^local checks: passed earlier on tree /);
    } finally {
      repo.remove();
    }
  });

  it('writes a file, creating its folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'teamrig-local-write-'));
    try {
      const path = join(root, 'a', 'b', 'c.json');
      writeTextFile(path, 'x');
      assert.equal(machineDeps(root, {}, () => undefined).readText(path), 'x');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
