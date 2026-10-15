import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
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

  it('passes a tree that passed earlier without running a check', () => {
    const { head, tree } = commit();
    recordPass(tree, head);
    const result = repo.run(CLI);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^local checks: passed earlier on tree [0-9a-f]{7} \(commit [0-9a-f]{7}, 2026-10-15T10:00:00\.000Z, 1 check\(s\)\)\n$/);
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
    const pushed = repo.run(CLI, args, {}, `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n`);
    assert.equal(pushed.status, 0, pushed.stderr);
    assert.match(pushed.stdout, /^local checks: refs\/heads\/main \(tree [0-9a-f]{7}\) passed earlier/);

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
