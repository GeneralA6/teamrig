import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TempRepo } from '../lib/temp-repo.ts';

const CLI = fileURLToPath(new URL('./local.ts', import.meta.url));

describe('local (the local gate CLI)', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo('local-cli');
  });
  afterEach(() => repo.remove());

  /** Commits one file and returns the commit and its tree. */
  function commit(): { readonly head: string; readonly tree: string } {
    repo.init().write('a.txt', 'a\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'a');
    return { head: repo.git('rev-parse', 'HEAD').trim(), tree: repo.git('rev-parse', 'HEAD^{tree}').trim() };
  }

  /** Writes a pass record for the tree, as an earlier run would. */
  function recordPass(tree: string, head: string): void {
    repo.write(`.git/local-ci/${tree}.json`, JSON.stringify({ tree, commit: head, checks: ['scrub: tree'], passedAt: '2026-10-15T10:00:00.000Z', node: 'v22.0.0' }));
  }

  it('runs the checks on a tree with no record and stops at the first failure', () => {
    commit();
    const result = repo.run(CLI);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^FAIL: scrub: tree \(exit 1, \d+s\)$/m);
    assert.match(result.stdout, /^local checks: REFUSED scrub: tree failed on tree [0-9a-f]{7}$/m);
    assert.doesNotMatch(result.stdout, /scrub: commits/);
  });

  it('runs its checks below normal priority, as a queued step runs, so a hand push leaves the CPU to the owner (T4064)', () => {
    repo.init().write('tools/scrub/cli.ts', "import { getPriority } from 'node:os';\nconsole.log(`priority ${getPriority()}`);\nprocess.exit(1);\n");
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'a');
    const result = repo.run(CLI);
    const priority = Number(/^priority (-?\d+)$/m.exec(result.stdout)?.[1]);
    assert.ok(priority >= constants.priority.PRIORITY_BELOW_NORMAL, result.stdout);
  });

  it('passes a tree that passed earlier without running a check', () => {
    const { head, tree } = commit();
    recordPass(tree, head);
    const result = repo.run(CLI);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^local checks: passed earlier on tree [0-9a-f]{7} \(commit [0-9a-f]{7}, 2026-10-15T10:00:00\.000Z, 1 check\(s\)\)\n$/);
  });

  it('--short runs the short checks, naming the changed specs since the base, and reuses a short record (T3414)', () => {
    const { head: base } = commit();
    repo.write('src/x.ts', 'export const x = 1;\n');
    repo.write('src/x.test.ts', '// x\n');
    repo.write('notes.md', 'n\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'x');
    const head = repo.git('rev-parse', 'HEAD').trim();
    const tree = repo.git('rev-parse', 'HEAD^{tree}').trim();
    const intro = (count: number, since: string): string => `short checks: scrub, DCO, typecheck and ${count} changed spec(s) since ${since}; required CI runs the whole suite on the pull request`;

    const run = repo.run(CLI, ['--short', '--base', base]);
    assert.equal(run.status, 1, run.stderr);
    assert.ok(run.stdout.startsWith(`${intro(1, base)}\n  src/x.test.ts\nFAIL: scrub: tree (exit 1, `), run.stdout);

    repo.write(`.git/local-ci/short/${tree}.json`, JSON.stringify({ tree, commit: head, checks: ['scrub: tree'], passedAt: '2026-10-15T10:00:00.000Z', node: 'v22.0.0' }));
    const reused = repo.run(CLI, ['--short', '--base', 'HEAD']);
    assert.equal(reused.status, 0, reused.stderr);
    assert.match(reused.stdout, new RegExp(`^${intro(0, 'HEAD').replace(/[()]/g, '\\$&')}\nshort checks: passed earlier on tree [0-9a-f]{7} \\(commit [0-9a-f]{7}, 2026-10-15T10:00:00\\.000Z, 1 check\\(s\\)\\)\n$`));

    const full = repo.run(CLI);
    assert.equal(full.status, 1, 'a short record never passes a full proof');
    assert.match(full.stdout, /^FAIL: scrub: tree/);
  });

  it('refuses uncommitted changes', () => {
    commit();
    repo.write('b.txt', 'b\n');
    const result = repo.run(CLI);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^local checks: REFUSED the checkout has uncommitted changes \(\?\? b\.txt\)/);
  });

  it('as the pre-push hook, proves each pushed commit and ignores the remote git names', () => {
    const { head, tree } = commit();
    recordPass(tree, head);
    const args = ['--pre-push', 'origin', 'https://example.invalid/repo.git'];
    const pushed = repo.run(CLI, args, {}, `refs/heads/topic ${head} refs/heads/topic ${'0'.repeat(40)}\n`);
    assert.equal(pushed.status, 0, pushed.stderr);
    assert.match(pushed.stdout, /^local checks: refs\/heads\/topic \(tree [0-9a-f]{7}\) passed earlier/);

    const toMain = repo.run(CLI, args, {}, `refs/heads/topic ${head} refs/heads/main ${'0'.repeat(40)}\n`);
    assert.deepEqual([toMain.status, toMain.stdout], [1, 'local checks: REFUSED refs/heads/main changes only through a pull request: push a branch of your own and open a pull request from it\n']);

    const empty = repo.run(CLI, args);
    assert.deepEqual([empty.status, empty.stdout], [0, 'local checks: nothing to push\n']);

    const garbled = repo.run(CLI, args, {}, 'refs/heads/main\n');
    assert.deepEqual([garbled.status, garbled.stderr], [2, 'local: pre-push: unexpected line from git: refs/heads/main\n']);
  });

  it('exits 2 on an unknown option and outside a repo', () => {
    const unknown = repo.run(CLI, ['--skip']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /^local: Unknown option '--skip'/);

    const outside = repo.run(CLI);
    assert.equal(outside.status, 2);
    assert.match(outside.stderr, /^local: git rev-parse --show-toplevel failed: /);
  });
});
