import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TempRepo } from '../../tools/lib/temp-repo.ts';
import { gitEnvironment, outcome, query, queryLine, runGit } from './git-run.ts';

describe('gitEnvironment', () => {
  it('drops the variables that point git at another repository, in any case, and keeps the rest', () => {
    assert.deepEqual(gitEnvironment({ GIT_DIR: '/repo/.git', git_index_file: 'index', GIT_WORK_TREE: '/repo', GIT_AUTHOR_NAME: 'Dana', PATH: '/bin' }), {
      GIT_AUTHOR_NAME: 'Dana',
      PATH: '/bin',
    });
  });
});

describe('runGit and its readers', () => {
  it('reads a query in the folder named, and an empty or failed one as unknown', () => {
    const repo = new TempRepo('git-run').init();
    try {
      assert.equal(queryLine(repo.dir, ['rev-parse', '--is-inside-work-tree']), 'true');
      assert.equal(query(repo.dir, ['rev-parse', '--verify', '--quiet', 'HEAD']), undefined);
      assert.equal(queryLine(repo.dir, ['branch', '--list', 'none']), undefined);
    } finally {
      repo.remove();
    }
  });

  it('gives a failed step the reason git printed, or its exit code when git said nothing', () => {
    const repo = new TempRepo('git-run').init();
    try {
      assert.deepEqual(outcome(runGit(repo.dir, ['status', '--short']), 'status'), { ok: true });
      const refused = outcome(runGit(repo.dir, ['branch', '-D', 'none']), 'branch -D');
      assert.equal(refused.ok, false);
      assert.match(refused.ok ? '' : refused.reason, /none/);
      assert.deepEqual(outcome({ status: 3, stdout: '', stderr: ' ' }, 'git push'), { ok: false, reason: 'git push exited 3' });
      assert.deepEqual(outcome({ status: null, stdout: '', stderr: '' }, 'git push'), { ok: false, reason: 'git push exited without a code' });
    } finally {
      repo.remove();
    }
  });
});
