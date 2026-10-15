import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TempRepo } from '../../tools/lib/temp-repo.ts';
import { GIT_CLI, GIT_COMMIT_LOG } from './git.ts';

describe('GIT_CLI', () => {
  it('reads the branch of a new repository, with no push target yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamrig-git-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: dir, stdio: 'ignore' });
      assert.equal(GIT_CLI.branch(dir), 'trunk');
      assert.equal(GIT_CLI.pushTarget(dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads as unknown where git cannot run', () => {
    const missing = join(tmpdir(), 'teamrig-no-such-folder');
    assert.equal(GIT_CLI.branch(missing), undefined);
    assert.equal(GIT_CLI.pushTarget(missing), undefined);
    assert.deepEqual(GIT_CLI.config(missing, 'alias.ship'), { kind: 'unreadable' });
  });

  it('reads a config key as set or unset', () => {
    const repo = new TempRepo('git-config').init();
    try {
      repo.git('config', 'alias.ship', 'push origin main');
      assert.deepEqual(GIT_CLI.config(repo.dir, 'alias.ship'), { kind: 'set', value: 'push origin main' });
      assert.deepEqual(GIT_CLI.config(repo.dir, 'alias.teamrig-never-set'), { kind: 'unset' });
    } finally {
      repo.remove();
    }
  });

  it('reads the push target of a named branch as well as of the checked-out one', () => {
    const repo = new TempRepo('git-push-target').init();
    try {
      repo.git('commit', '-q', '--allow-empty', '-m', 'Base');
      repo.git('branch', '-M', 'main');
      repo.git('config', 'push.default', 'simple');
      repo.git('config', 'remote.origin.url', repo.outside);
      repo.git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
      repo.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      repo.git('branch', '--set-upstream-to=origin/main', 'main');
      assert.equal(GIT_CLI.pushTarget(repo.dir), 'origin/main');
      repo.git('switch', '-q', '-c', 'feature');
      assert.equal(GIT_CLI.pushTarget(repo.dir, 'main'), 'origin/main');
      assert.equal(GIT_CLI.pushTarget(repo.dir), undefined);
      assert.equal(GIT_CLI.pushTarget(repo.dir, '-main'), undefined);
    } finally {
      repo.remove();
    }
  });
});

describe('GIT_COMMIT_LOG', () => {
  it('lists the commits a range adds, newest first, with their numstat', () => {
    const repo = new TempRepo('commit-log').init();
    try {
      repo.write('a.ts', 'one\n');
      repo.git('add', '.');
      repo.git('commit', '-q', '-m', 'Base');
      repo.git('branch', 'base');
      repo.write('a.ts', 'one\ntwo\n');
      repo.write('src/a.test.ts', 'x\n');
      repo.git('add', '.');
      repo.git('commit', '-q', '-m', 'Grow a', '-m', 'Large-commit: test');
      repo.git('mv', 'a.ts', 'b.ts');
      repo.git('commit', '-q', '-m', 'Move a');
      const commits = GIT_COMMIT_LOG.between(repo.dir, 'base', 'HEAD');
      assert.deepEqual(
        commits?.map((commit) => [commit.sha.length, commit.subject, commit.body, commit.files]),
        [
          [40, 'Move a', '', [{ path: 'a.ts => b.ts', added: 0, deleted: 0 }]],
          [
            40,
            'Grow a',
            'Large-commit: test',
            [
              { path: 'a.ts', added: 1, deleted: 0 },
              { path: 'src/a.test.ts', added: 1, deleted: 0 },
            ],
          ],
        ],
      );
      assert.deepEqual(GIT_COMMIT_LOG.between(repo.dir, 'HEAD', 'HEAD'), []);
      assert.equal(GIT_COMMIT_LOG.between(repo.dir, 'no-such-ref', 'HEAD'), undefined);
    } finally {
      repo.remove();
    }
  });
});
