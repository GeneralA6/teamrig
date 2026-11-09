import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { TempRepo } from '../lib/temp-repo.ts';
import {
  type BranchState,
  type Git,
  type LeftoversDeps,
  LEFTOVERS_USAGE,
  isRegenerated,
  leftoverLines,
  leftoversCommand,
  parseLog,
  planSweep,
  readStates,
  realLeftoversDeps,
  sweepAfterMerge,
  taskOf,
  workCommits,
} from './leftovers.ts';
import { type RepoProfile, parseProfiles } from './repos.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const REGENERATED = ['dist/', 'plugin.json'] as const;
const PROFILE: RepoProfile = { slug: 'O/R', main: 'main', gate: 'local', checks: [], local: { runner: 'tools/ci/local.ts' }, regenerated: REGENERATED };

test('parses each NUL-led record of sha, parents and files, a merge with two parents', () => {
  const text = `\0${A} ${B}\n\nsrc/a.ts\ndist/a.js\n\0${B} ${C} ${A}\n\0${C}\n\nplugin.json\n`;
  assert.deepEqual(parseLog(text), [
    { sha: A, parents: [B], files: ['src/a.ts', 'dist/a.js'] },
    { sha: B, parents: [C, A], files: [] },
    { sha: C, parents: [], files: ['plugin.json'] },
  ]);
  assert.deepEqual(parseLog(''), []);
  assert.throws(() => parseLog('\0fatal: bad revision\n'), /git log: unexpected commit line "fatal: bad revision"/);
  assert.throws(() => parseLog(`\0${A} not-a-sha\n`), /unexpected commit line/);
});

test('a regenerated path is one listed, or one inside a listed folder', () => {
  assert.ok(isRegenerated('dist/cli/run.js', REGENERATED));
  assert.ok(isRegenerated('plugin.json', REGENERATED));
  assert.ok(!isRegenerated('dist.ts', REGENERATED), 'a folder entry matches only inside the folder');
  assert.ok(!isRegenerated('src/plugin.json', REGENERATED), 'a file entry matches only that path');
});

test('work is a merge, or a commit touching any path the profile does not call regenerated', () => {
  const commits = [
    { sha: A, parents: [B], files: ['dist/a.js', 'plugin.json'] },
    { sha: B, parents: [C], files: ['dist/a.js', 'src/a.ts'] },
    { sha: C, parents: [A, B], files: [] },
  ];
  assert.deepEqual(workCommits(commits, REGENERATED).map(commit => commit.sha), [B, C]);
  assert.deepEqual(workCommits(commits, []).map(commit => commit.sha), [A, B, C]);
});

test('a branch names its task by its t<id>- prefix, in lower case', () => {
  assert.equal(taskOf('t1867-reship-leftovers'), 't1867');
  assert.equal(taskOf('T838-heavy-guard-r'), 't838');
  assert.equal(taskOf('feature-x'), null);
  assert.equal(taskOf('t12'), null);
});

test('a merge sweeps the leftovers of its own task only, never the merged head or a branch with work', () => {
  const states: BranchState[] = [
    { branch: 't5-new', ahead: 0 },
    { branch: 't5-old', ahead: 0 },
    { branch: 'T5-older', ahead: 0 },
    { branch: 't5-wip', ahead: 2 },
    { branch: 't50-other', ahead: 0 },
    { branch: 'docs-fix', ahead: 0 },
  ];
  assert.deepEqual(planSweep('t5-new', states), { remove: ['t5-old', 'T5-older'], leave: ['t50-other', 'docs-fix'] });
  assert.deepEqual(planSweep('docs-x', states), { remove: [], leave: ['t5-new', 't5-old', 'T5-older', 't50-other', 'docs-fix'] });
});

test('lists leftovers first, then branches with work, then the counts', () => {
  const states: BranchState[] = [
    { branch: 't6-work', ahead: 3 },
    { branch: 't5-old', ahead: 0 },
  ];
  assert.deepEqual(leftoverLines(states, 'main'), ['LEFTOVER t5-old: its work is on main', 't6-work: 3 commit(s) main lacks', '2 remote branch(es) besides main, 1 leftover(s)']);
});

/** A git in the temp repo, trimmed as the real dep is. */
const gitIn =
  (repo: TempRepo): Git =>
  (...args) =>
    repo.git(...args).trim();

function commit(repo: TempRepo, path: string, content: string, message: string): void {
  repo.write(path, content);
  repo.git('add', '--', path);
  repo.git('commit', '-q', '-m', message);
}

describe('against a real origin', () => {
  let repo: TempRepo;
  let origin: string;

  /**
   * main, then t5-old (a code change, a version raise and a dist build on it); main then takes another
   * task's version raise, so t5-new, t5-old rebased onto it, raises the version from another number and
   * builds another dist. t5-new lands on main; t6-work holds a change main lacks; t7-merge merges t6-work; t9-done is an ancestor of main.
   */
  beforeEach(() => {
    repo = new TempRepo('leftovers').init();
    origin = join(repo.outside, 'origin.git');
    repo.git('init', '-q', '--bare', origin);
    repo.git('remote', 'add', 'origin', origin);
    repo.git('symbolic-ref', 'HEAD', 'refs/heads/main');
    commit(repo, 'plugin.json', '{"version":"1.0.0"}\n', 'first');
    repo.git('branch', 't9-done');
    commit(repo, 'src/a.ts', 'export const a = 1;\n', 'a');
    repo.git('checkout', '-q', '-b', 't5-old');
    commit(repo, 'src/a.ts', 'export const a = 2;\n', 'change a');
    commit(repo, 'plugin.json', '{"version":"1.1.0"}\n', 'raise to 1.1.0');
    commit(repo, 'dist/a.js', 'a = 2;\n', 'build');
    repo.git('checkout', '-q', 'main');
    commit(repo, 'plugin.json', '{"version":"1.0.1"}\n', 'another task raises to 1.0.1');
    repo.git('checkout', '-q', '-b', 't5-new');
    repo.git('cherry-pick', 't5-old~2');
    commit(repo, 'plugin.json', '{"version":"1.1.0"}\n', 'raise to 1.1.0');
    commit(repo, 'dist/a.js', 'a = 2; // built on 1.0.1\n', 'build');
    repo.git('checkout', '-q', 'main');
    repo.git('merge', '-q', '--ff-only', 't5-new');
    repo.git('checkout', '-q', '-b', 't6-work');
    commit(repo, 'src/b.ts', 'export const b = 1;\n', 'b');
    repo.git('checkout', '-q', '-b', 't7-merge', 'main');
    repo.git('merge', '-q', '--no-ff', '-m', 'merge t6-work', 't6-work');
    repo.git('checkout', '-q', 'main');
    repo.git('push', '-q', 'origin', 'main', 't5-old', 't5-new', 't6-work', 't7-merge', 't9-done');
    repo.git('remote', 'set-head', 'origin', 'main');
  });
  afterEach(() => repo.remove());

  test('a branch whose commits main repeats or that only regenerate files is a leftover; HEAD and main are skipped', () => {
    const states = readStates(gitIn(repo), 'main', REGENERATED);
    assert.deepEqual(
      [...states].sort((a, b) => a.branch.localeCompare(b.branch)),
      [
        { branch: 't5-new', ahead: 0 },
        { branch: 't5-old', ahead: 0 },
        { branch: 't6-work', ahead: 1 },
        { branch: 't7-merge', ahead: 2 },
        { branch: 't9-done', ahead: 0 },
      ],
    );
    const unlisted = readStates(gitIn(repo), 'main', []).find(state => state.branch === 't5-old');
    assert.deepEqual(unlisted, { branch: 't5-old', ahead: 2 }, 'without the regenerated list the raise and the build count as work');
  });

  test('a branch deleted on origin since the last fetch is pruned, not listed', () => {
    repo.git('--git-dir', origin, 'update-ref', '-d', 'refs/heads/t9-done');
    assert.ok(!readStates(gitIn(repo), 'main', REGENERATED).some(state => state.branch === 't9-done'));
  });

  test('after t5-new merged, the sweep deletes t5-old on origin and names t9-done, keeping t5-new and the branches with work', () => {
    const out: string[] = [];
    const err: string[] = [];
    sweepAfterMerge('t5-new', PROFILE, { git: gitIn(repo), out: line => out.push(line), err: line => err.push(line) });
    assert.deepEqual(err, []);
    assert.deepEqual(out, ["deleted t5-old: an earlier push of t5-new's task, its work is on main", "LEFTOVER t9-done: its work is on main; not t5-new's task, so left to its owner"]);
    const left = repo.git('--git-dir', origin, 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/').trim().split('\n');
    assert.deepEqual(left.sort(), ['main', 't5-new', 't6-work', 't7-merge', 't9-done']);
  });

  test('ship.ts leftovers lists every branch on origin and deletes none', () => {
    const real = gitIn(repo);
    const out: string[] = [];
    const deps: LeftoversDeps = {
      git: (...args) => (args.join(' ') === 'remote get-url origin' ? 'git@github.com:O/R.git' : real(...args)),
      profiles: parseProfiles('{"O/R":{"main":"main","gate":"local","checks":[],"local":{"runner":"tools/ci/local.ts"},"regenerated":["dist/","plugin.json"]}}'),
      out: line => out.push(line),
      err: line => assert.fail(line),
    };
    assert.equal(leftoversCommand([repo.dir], dir => (dir === repo.dir ? deps : assert.fail(dir))), 0);
    assert.equal(out.length, 6);
    assert.deepEqual(out.filter(line => line.startsWith('LEFTOVER ')).sort(), ['LEFTOVER t5-new: its work is on main', 'LEFTOVER t5-old: its work is on main', 'LEFTOVER t9-done: its work is on main']);
    assert.equal(out.at(-1), '5 remote branch(es) besides main, 3 leftover(s)');
    assert.equal(repo.git('--git-dir', origin, 'for-each-ref', 'refs/heads/').trim().split('\n').length, 6);
  });
});

/** git that answers a sweep's reads with two leftovers of t5 and fails each delete, or fails the fetch. */
function failingGit(failAt: 'fetch' | 'delete', calls: string[]): Git {
  return (...args) => {
    const key = args.join(' ');
    calls.push(key);
    if (key === 'fetch --quiet --prune origin') {
      if (failAt === 'fetch') throw new Error('Command failed: git fetch\nssh: connect to host github.com port 22: timed out');
      return '';
    }
    if (key.startsWith('for-each-ref')) return 'HEAD\nmain\nt5-old\nt5-older';
    if (key.startsWith('log ')) return '';
    throw new Error('Command failed: git push\nerror: unable to delete: remote ref does not exist');
  };
}

test('a failed delete or a failed read is a LEFTOVER line, never a throw: the merge already landed', () => {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
  sweepAfterMerge('t5-new', PROFILE, { ...deps, git: failingGit('delete', calls) });
  assert.deepEqual(calls.filter(call => call.startsWith('push')), ['push --quiet origin --delete t5-old', 'push --quiet origin --delete t5-older']);
  assert.deepEqual(err, [
    'LEFTOVER t5-old: its work is on main, but the delete failed: Command failed: git push',
    'LEFTOVER t5-older: its work is on main, but the delete failed: Command failed: git push',
  ]);
  assert.deepEqual(out, []);

  err.length = 0;
  sweepAfterMerge('t5-new', PROFILE, { ...deps, git: failingGit('fetch', []) });
  assert.deepEqual(err, ['LEFTOVER sweep skipped: Command failed: git fetch']);
});

test('ship.ts leftovers takes exactly one repo dir, and a git or profile error is one line and exit 1', t => {
  const consoleError = t.mock.method(console, 'error', () => undefined);
  for (const argv of [[], ['--help'], ['C:/repo', 'extra']]) assert.equal(leftoversCommand(argv, () => assert.fail('no deps without a repo dir')), 1);
  assert.deepEqual(
    consoleError.mock.calls.map(call => call.arguments[0]),
    [LEFTOVERS_USAGE, LEFTOVERS_USAGE, LEFTOVERS_USAGE],
  );
  const err: string[] = [];
  const deps: LeftoversDeps = {
    git: () => 'git@github.com:Owner/unknown.git',
    profiles: parseProfiles('{}'),
    out: line => assert.fail(line),
    err: line => err.push(line),
  };
  assert.equal(leftoversCommand(['C:/repo'], () => deps), 1);
  assert.deepEqual(err, ['no check list for Owner/unknown: add it to repos.json (a repo without one cannot merge)']);
});

test('the real wiring runs git in the named dir, reads repos.json and writes to the console', t => {
  const repo = new TempRepo('leftovers-wiring').init();
  t.after(() => repo.remove());
  const consoleLog = t.mock.method(console, 'log', () => undefined);
  const consoleError = t.mock.method(console, 'error', () => undefined);
  const deps = realLeftoversDeps(repo.dir);
  assert.equal(deps.git('rev-parse', '--is-inside-work-tree'), 'true');
  assert.ok(deps.profiles.size > 0);
  deps.out('an out line');
  deps.err('an err line');
  assert.deepEqual(consoleLog.mock.calls.map(call => call.arguments[0]), ['an out line']);
  assert.deepEqual(consoleError.mock.calls.map(call => call.arguments[0]), ['an err line']);
});
