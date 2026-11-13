import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { TempRepo } from '../lib/temp-repo.ts';
import type { Gh } from './github.ts';
import {
  type BranchState,
  type Git,
  type HeadPull,
  type LeftoversDeps,
  LEFTOVERS_USAGE,
  closedHeadOf,
  isRegenerated,
  leftoverLines,
  leftoversCommand,
  parseHeadPull,
  parseLog,
  planSweep,
  pullsOfHead,
  readStates,
  realLeftoversDeps,
  settleMergedHead,
  sweepAfterMerge,
  sweepClosedHeads,
  taskOf,
  workCommits,
} from './leftovers.ts';
import { type RepoProfile, parseProfiles } from './repos.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const REGENERATED = ['dist/', 'plugin.json'] as const;
const PROFILE: RepoProfile = { slug: 'O/R', main: 'main', gate: 'local', checks: [], summary: null, local: { runner: 'tools/ci/local.ts' }, regenerated: REGENERATED };

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
    { branch: 't5-new', sha: A, ahead: 0 },
    { branch: 't5-old', sha: A, ahead: 0 },
    { branch: 'T5-older', sha: A, ahead: 0 },
    { branch: 't5-wip', sha: A, ahead: 2 },
    { branch: 't50-other', sha: A, ahead: 0 },
    { branch: 'docs-fix', sha: A, ahead: 0 },
  ];
  assert.deepEqual(planSweep('t5-new', states), { remove: ['t5-old', 'T5-older'], leave: ['t50-other', 'docs-fix'] });
  assert.deepEqual(planSweep('docs-x', states), { remove: [], leave: ['t5-new', 't5-old', 'T5-older', 't50-other', 'docs-fix'] });
});

test('lists leftovers first, then branches with work, then the counts', () => {
  const states: BranchState[] = [
    { branch: 't6-work', sha: A, ahead: 3 },
    { branch: 't5-old', sha: B, ahead: 0 },
  ];
  assert.deepEqual(leftoverLines(states, 'main'), ['LEFTOVER t5-old: its work is on main', 't6-work: 3 commit(s) main lacks', '2 remote branch(es) besides main, 1 leftover(s)']);
});

const pull = (number: number, fields: Partial<HeadPull> = {}): HeadPull => ({ number, open: false, merged: false, headRepo: 'O/R', headSha: A, ...fields });

test('reads a pull request as open or closed, merged or not, with its head repo, null when that repo is gone', () => {
  assert.deepEqual(parseHeadPull({ number: 7, state: 'closed', merged_at: null, head: { sha: A, repo: { full_name: 'O/R' } } }), pull(7));
  assert.deepEqual(parseHeadPull({ number: 8, state: 'closed', merged_at: '2026-11-13T10:00:00Z', head: { sha: B, repo: null } }), pull(8, { merged: true, headRepo: null, headSha: B }));
  assert.deepEqual(parseHeadPull({ number: 9, state: 'open', head: { sha: A, repo: { full_name: 'X/R' } } }), pull(9, { open: true, headRepo: 'X/R' }));
  assert.throws(() => parseHeadPull({ number: 9, state: 'open', head: { repo: null } }), /pull request head: "sha" is not a string/);
});

test("asks GitHub for every pull request, open or closed, whose head is the branch in the owner's account", () => {
  const calls: (readonly string[])[] = [];
  const gh: Gh = args => {
    calls.push(args);
    return JSON.stringify([{ number: 4, state: 'closed', merged_at: null, head: { sha: A, repo: { full_name: 'O/R' } } }, 'not a pull request']);
  };
  assert.deepEqual(pullsOfHead(gh, 'O/R')('t5-a&b'), [pull(4)]);
  assert.deepEqual(calls, [['api', 'repos/O/R/pulls?state=all&head=O%3At5-a%26b&per_page=100']]);
  assert.throws(() => pullsOfHead(() => '{}', 'O/R')('t5'), /pull requests: expected a list/);
});

test('a closed head is deleted only at the closed, unmerged pull request head sha in the repo itself, with no open one on it', () => {
  assert.deepEqual(closedHeadOf([pull(9, { headSha: B }), pull(4)], 'O/R', A), { kind: 'delete', pull: 4 });
  assert.deepEqual(closedHeadOf([pull(9, { headSha: B }), pull(4, { headSha: C })], 'O/R', A), { kind: 'moved', pull: 9 }, 'pushed again after the close');
  assert.deepEqual(closedHeadOf([], 'O/R', A), { kind: 'none' }, 'never a pull request');
  assert.deepEqual(closedHeadOf([pull(9, { open: true, headSha: B }), pull(4)], 'O/R', A), { kind: 'none' }, 'reopened as another pull request');
  assert.deepEqual(closedHeadOf([pull(4, { merged: true })], 'O/R', A), { kind: 'none' }, 'a merged one is not a closed head');
  assert.deepEqual(closedHeadOf([pull(4, { headRepo: 'O/fork' }), pull(5, { headRepo: null })], 'O/R', A), { kind: 'none' }, 'a head in another repo of the owner');
});

/** git answering ls-remote from a list of answers in turn (a thrown Error for a failed call), and failing or passing the push. */
function scriptedGit(lsRemote: readonly (string | Error)[], push: 'ok' | 'fail', calls: string[]): Git {
  let reads = 0;
  return (...args) => {
    const key = args.join(' ');
    calls.push(key);
    if (args[0] === 'ls-remote') {
      const answer = lsRemote[reads++] ?? '';
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (push === 'fail') throw new Error('Command failed: git push\n ! [rejected] (stale info)');
    return '';
  };
}

test('the merged head is deleted at the merged sha under a lease, named at another sha, and left alone when gone', () => {
  const merged = { repo: 'O/R', head: 't5-new', sha: A };
  const run = (lsRemote: readonly (string | Error)[], push: 'ok' | 'fail'): { calls: string[]; out: string[]; err: string[] } => {
    const calls: string[] = [];
    const out: string[] = [];
    const err: string[] = [];
    settleMergedHead(merged, { git: scriptedGit(lsRemote, push, calls), out: line => out.push(line), err: line => err.push(line) });
    return { calls, out, err };
  };
  const at = `${A}\trefs/heads/t5-new`;
  const deleted = run([at], 'ok');
  assert.deepEqual(deleted.calls, ['ls-remote origin refs/heads/t5-new', `push --quiet --force-with-lease=refs/heads/t5-new:${A} origin :refs/heads/t5-new`]);
  assert.deepEqual([deleted.out, deleted.err], [['deleted t5-new: merged, and origin still had it'], []]);

  const gone = run([''], 'ok');
  assert.deepEqual([gone.calls.length, gone.out, gone.err], [1, [], []]);

  const moved = run([`${B}\trefs/heads/t5-new`], 'ok');
  assert.deepEqual([moved.calls.length, moved.out, moved.err], [1, ['LEFTOVER t5-new: merged at aaaaaaa, but origin has it at bbbbbbb since; left to its owner'], []]);

  const raced = run([at, ''], 'fail');
  assert.deepEqual([raced.out, raced.err], [[], []], "GitHub's own delete won the race");

  const refused = run([at, at], 'fail');
  assert.deepEqual([refused.out, refused.err], [[], ['LEFTOVER t5-new: merged, but the delete failed: Command failed: git push']]);

  const unread = run([new Error('Command failed: git ls-remote\nfatal: unable to access')], 'ok');
  assert.deepEqual([unread.out, unread.err], [[], ['LEFTOVER t5-new: merged, but its check on origin failed: Command failed: git ls-remote']]);
});

test('a failed GitHub read stops the closed-head sweep with one line; a failed delete is a LEFTOVER line and the sweep goes on', () => {
  const states: BranchState[] = [
    { branch: 't1-a', sha: A, ahead: 1 },
    { branch: 't2-b', sha: A, ahead: 1 },
    { branch: 't3-c', sha: A, ahead: 1 },
  ];
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const reads: string[] = [];
  const deleted = sweepClosedHeads(states, 'O/R', {
    git: scriptedGit([], 'fail', calls),
    pullsOf: branch => {
      reads.push(branch);
      if (branch === 't3-c') throw new Error('gh: HTTP 502\nbad gateway');
      return [pull(branch === 't1-a' ? 1 : 2)];
    },
    out: line => out.push(line),
    err: line => err.push(line),
  });
  assert.deepEqual([...deleted], []);
  assert.deepEqual(reads, ['t1-a', 't2-b', 't3-c']);
  assert.deepEqual(out, []);
  assert.deepEqual(err, [
    'LEFTOVER t1-a: the head of #1, closed unmerged, but the delete failed: Command failed: git push',
    'LEFTOVER t2-b: the head of #2, closed unmerged, but the delete failed: Command failed: git push',
    'LEFTOVER closed-head sweep stopped at t3-c: gh: HTTP 502',
  ]);
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

  const shaOf = (branch: string): string => repo.git('rev-parse', branch).trim();
  const originBranches = (): string[] => repo.git('--git-dir', origin, 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/').trim().split('\n').sort();
  /** GitHub as seen after t6-work's pull request #6 closed unmerged at its sha, and t7-merge's #7 closed before its last push. */
  const closedPulls = (branch: string): HeadPull[] => {
    if (branch === 't6-work') return [pull(6, { headSha: shaOf('t6-work') })];
    if (branch === 't7-merge') return [pull(7, { headSha: shaOf('t6-work') })];
    return [];
  };

  test('a branch whose commits main repeats or that only regenerate files is a leftover; HEAD and main are skipped', () => {
    const states = readStates(gitIn(repo), 'main', REGENERATED);
    assert.deepEqual(
      [...states].sort((a, b) => a.branch.localeCompare(b.branch)),
      [
        { branch: 't5-new', sha: shaOf('t5-new'), ahead: 0 },
        { branch: 't5-old', sha: shaOf('t5-old'), ahead: 0 },
        { branch: 't6-work', sha: shaOf('t6-work'), ahead: 1 },
        { branch: 't7-merge', sha: shaOf('t7-merge'), ahead: 2 },
        { branch: 't9-done', sha: shaOf('t9-done'), ahead: 0 },
      ],
    );
    const unlisted = readStates(gitIn(repo), 'main', []).find(state => state.branch === 't5-old');
    assert.deepEqual(unlisted, { branch: 't5-old', sha: shaOf('t5-old'), ahead: 2 }, 'without the regenerated list the raise and the build count as work');
  });

  test('a branch deleted on origin since the last fetch is pruned, not listed', () => {
    repo.git('--git-dir', origin, 'update-ref', '-d', 'refs/heads/t9-done');
    assert.ok(!readStates(gitIn(repo), 'main', REGENERATED).some(state => state.branch === 't9-done'));
  });

  test('after t5-new merged, the sweep deletes t5-new, t5-old and the closed head t6-work on origin, and names t7-merge and t9-done', () => {
    const out: string[] = [];
    const err: string[] = [];
    const asked: string[] = [];
    const pullsOf = (branch: string): HeadPull[] => {
      asked.push(branch);
      return closedPulls(branch);
    };
    sweepAfterMerge({ repo: 'O/R', head: 't5-new', sha: shaOf('t5-new') }, PROFILE, { git: gitIn(repo), pullsOf, out: line => out.push(line), err: line => err.push(line) });
    assert.deepEqual(err, []);
    assert.deepEqual(out, [
      'deleted t5-new: merged, and origin still had it',
      "deleted t5-old: an earlier push of t5-new's task, its work is on main",
      'deleted t6-work: the head of #6, closed unmerged; Restore branch on the pull request brings it back',
      'LEFTOVER t7-merge: the head of #7, closed unmerged, pushed again since; left to its owner',
      "LEFTOVER t9-done: its work is on main; not t5-new's task, so left to its owner",
    ]);
    assert.deepEqual(asked, ['t6-work', 't7-merge', 't9-done'], 'the merged head and its deleted leftovers are not asked about');
    assert.deepEqual(originBranches(), ['main', 't7-merge', 't9-done']);
  });

  test('a merged head pushed again after the merge is named and kept', () => {
    const out: string[] = [];
    sweepAfterMerge({ repo: 'O/R', head: 't5-new', sha: shaOf('t5-old') }, PROFILE, { git: gitIn(repo), pullsOf: () => [], out: line => out.push(line), err: line => assert.fail(line) });
    assert.equal(out[0], `LEFTOVER t5-new: merged at ${shaOf('t5-old').slice(0, 7)}, but origin has it at ${shaOf('t5-new').slice(0, 7)} since; left to its owner`);
    assert.ok(originBranches().includes('t5-new'));
  });

  test('the lease keeps a closed head that origin moved after it was read', () => {
    const err: string[] = [];
    const stale = shaOf('main');
    const deleted = sweepClosedHeads([{ branch: 't6-work', sha: stale, ahead: 1 }], 'O/R', {
      git: gitIn(repo),
      pullsOf: () => [pull(6, { headSha: stale })],
      out: line => assert.fail(line),
      err: line => err.push(line),
    });
    assert.equal(deleted.size, 0);
    assert.match(err[0] ?? '', /^LEFTOVER t6-work: the head of #6, closed unmerged, but the delete failed: /);
    assert.ok(originBranches().includes('t6-work'));
  });

  test('ship.ts leftovers deletes the closed heads with the ship token and lists every other branch on origin', () => {
    const real = gitIn(repo);
    const out: string[] = [];
    const tokens: string[] = [];
    const deps: LeftoversDeps = {
      git: (...args) => (args.join(' ') === 'remote get-url origin' ? 'git@github.com:O/R.git' : real(...args)),
      profiles: parseProfiles('{"O/R":{"main":"main","gate":"local","checks":[],"local":{"runner":"tools/ci/local.ts"},"regenerated":["dist/","plugin.json"]}}'),
      credential: () => ({ kind: 'found', secret: 'ship-token' }),
      ghFor: token => {
        tokens.push(token);
        return args => {
          const branch = /head=O%3A([^&]+)/.exec(args[1] ?? '')?.[1] ?? assert.fail(args.join(' '));
          return JSON.stringify(branch === 't6-work' ? [{ number: 6, state: 'closed', merged_at: null, head: { sha: shaOf('t6-work'), repo: { full_name: 'O/R' } } }] : []);
        };
      },
      out: line => out.push(line),
      err: line => assert.fail(line),
    };
    assert.equal(leftoversCommand([repo.dir], dir => (dir === repo.dir ? deps : assert.fail(dir))), 0);
    assert.deepEqual(tokens, ['ship-token']);
    assert.equal(out[0], 'deleted t6-work: the head of #6, closed unmerged; Restore branch on the pull request brings it back');
    assert.deepEqual(out.filter(line => line.startsWith('LEFTOVER ')).sort(), ['LEFTOVER t5-new: its work is on main', 'LEFTOVER t5-old: its work is on main', 'LEFTOVER t9-done: its work is on main']);
    assert.equal(out.length, 6);
    assert.equal(out.at(-1), '4 remote branch(es) besides main, 3 leftover(s)');
    assert.deepEqual(originBranches(), ['main', 't5-new', 't5-old', 't7-merge', 't9-done']);
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
    if (key.startsWith('for-each-ref')) return `HEAD ${A}\nmain ${A}\nt5-old ${B}\nt5-older ${C}`;
    if (key.startsWith('log ') || key.startsWith('ls-remote ')) return '';
    throw new Error('Command failed: git push\nerror: unable to delete: remote ref does not exist');
  };
}

test('a failed delete or a failed read is a LEFTOVER line, never a throw: the merge already landed', () => {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps = { pullsOf: () => [], out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
  sweepAfterMerge({ repo: 'O/R', head: 't5-new', sha: A }, PROFILE, { ...deps, git: failingGit('delete', calls) });
  assert.deepEqual(calls.filter(call => call.startsWith('push')), ['push --quiet origin --delete t5-old', 'push --quiet origin --delete t5-older']);
  assert.deepEqual(err, [
    'LEFTOVER t5-old: its work is on main, but the delete failed: Command failed: git push',
    'LEFTOVER t5-older: its work is on main, but the delete failed: Command failed: git push',
  ]);
  assert.deepEqual(out, []);

  err.length = 0;
  sweepAfterMerge({ repo: 'O/R', head: 't5-new', sha: A }, PROFILE, { ...deps, git: failingGit('fetch', []) });
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
    credential: () => assert.fail('no token read for a repo with no profile'),
    ghFor: () => assert.fail('no GitHub call'),
    out: line => assert.fail(line),
    err: line => err.push(line),
  };
  assert.equal(leftoversCommand(['C:/repo'], () => deps), 1);
  assert.deepEqual(err, ['no check list for Owner/unknown: add it to repos.json (a repo without one cannot merge)']);

  err.length = 0;
  const gitCalls: string[] = [];
  const tokenless: LeftoversDeps = {
    ...deps,
    git: (...args) => {
      gitCalls.push(args.join(' '));
      return 'git@github.com:O/R.git';
    },
    profiles: parseProfiles('{"O/R":{"main":"main","gate":"local","checks":[],"local":{"runner":"tools/ci/local.ts"},"regenerated":[]}}'),
    credential: () => ({ kind: 'missing' }),
  };
  assert.equal(leftoversCommand(['C:/repo'], () => tokenless), 1);
  assert.match(err[0] ?? '', /teamrig-ship-gh: not stored/);
  assert.deepEqual(gitCalls, ['remote get-url origin'], 'no fetch without a token');
});

test('the real wiring runs git in the named dir, reads repos.json and writes to the console', t => {
  const repo = new TempRepo('leftovers-wiring').init();
  t.after(() => repo.remove());
  const consoleLog = t.mock.method(console, 'log', () => undefined);
  const consoleError = t.mock.method(console, 'error', () => undefined);
  const deps = realLeftoversDeps(repo.dir);
  assert.equal(deps.git('rev-parse', '--is-inside-work-tree'), 'true');
  assert.equal(typeof deps.ghFor('a token'), 'function');
  assert.ok(deps.profiles.size > 0);
  deps.out('an out line');
  deps.err('an err line');
  assert.deepEqual(consoleLog.mock.calls.map(call => call.arguments[0]), ['an out line']);
  assert.deepEqual(consoleError.mock.calls.map(call => call.arguments[0]), ['an err line']);
});
