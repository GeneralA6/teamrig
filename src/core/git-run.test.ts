import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TempRepo } from '../../tools/lib/temp-repo.ts';
import { join } from 'node:path';
import { gitEnvironment, outcome, query, queryLine, runGit, unansweredOf } from './git-run.ts';

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

describe('unansweredOf (T3368)', () => {
  it("reads git's own exit, a no too, as an answer", () => {
    for (const status of [0, 1, 128, 255]) {
      assert.equal(unansweredOf({ status, signal: null }), undefined, String(status));
    }
  });

  it('tells a git that did not start, was stopped or died starting from one that answered', () => {
    assert.equal(unansweredOf({ error: new Error('spawnSync git ENOENT'), status: null, signal: null }), 'spawnSync git ENOENT');
    assert.equal(unansweredOf({ status: null, signal: 'SIGTERM' }), 'stopped by SIGTERM');
    assert.equal(unansweredOf({ status: null, signal: null }), 'stopped by a signal');
    assert.equal(unansweredOf({ status: 3_221_225_794, signal: null }), 'ended with 0xC0000142, as a process that died starting does');
    assert.equal(unansweredOf({ status: -1, signal: null }), 'ended with 0xFFFFFFFF, as a process that died starting does');
  });

  it('marks a run git gave no answer to, and none it answered', () => {
    const repo = new TempRepo('git-run').init();
    try {
      assert.equal(runGit(repo.dir, ['rev-parse', '--verify', '--quiet', 'HEAD']).unanswered, undefined, "git's no");
      assert.notEqual(runGit(join(repo.outside, 'gone'), ['status']).unanswered, undefined, 'a folder git cannot start in');
    } finally {
      repo.remove();
    }
  });
});
