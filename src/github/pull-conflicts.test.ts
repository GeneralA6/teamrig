import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { TempRepo } from '../../tools/lib/temp-repo.ts';
import { FakePullGit } from '../testing/fake-pull-git.ts';
import { GIT_PULLS, githubRepoOf, mergeTreeOutcome, pullConflicts, pullRef } from './pull-conflicts.ts';

const WEB_7 = { repo: 'acme/web', number: 7 };

describe('githubRepoOf', () => {
  it('reads owner/name, lower case, from an https, ssh or scp-style GitHub URL', () => {
    assert.equal(githubRepoOf('https://github.com/Acme/Web.git'), 'acme/web');
    assert.equal(githubRepoOf('https://github.com/acme/web'), 'acme/web');
    const withUser = new URL('https://github.com/acme/web.git');
    withUser.username = 'token';
    assert.equal(githubRepoOf(withUser.href), 'acme/web');
    assert.equal(githubRepoOf('ssh://git@github.com/acme/web.git'), 'acme/web');
    assert.equal(githubRepoOf('git@github.com:acme/my.site.git\n'), 'acme/my.site');
  });

  it('names no repository for another host, a local folder or a deeper path', () => {
    assert.equal(githubRepoOf('https://gitlab.com/acme/web.git'), undefined);
    assert.equal(githubRepoOf('https://github.com.evil.test/acme/web.git'), undefined);
    assert.equal(githubRepoOf('/srv/git/web.git'), undefined);
    assert.equal(githubRepoOf('https://github.com/acme/web/pulls'), undefined);
  });
});

describe('mergeTreeOutcome', () => {
  it('reads exit 0 as clean and exit 1 as the NUL-ended paths after the tree id', () => {
    assert.deepEqual(mergeTreeOutcome({ status: 0, stdout: 'abc\0', stderr: '' }), { kind: 'clean' });
    assert.deepEqual(mergeTreeOutcome({ status: 1, stdout: 'abc\0f one.txt\0g.txt\0g.txt\0', stderr: '' }), { kind: 'conflicts', files: ['f one.txt', 'g.txt'] });
  });

  it("reads any other exit as a failure with git's own reason", () => {
    assert.deepEqual(mergeTreeOutcome({ status: 128, stdout: '', stderr: 'fatal: refusing to merge unrelated histories\n' }), { kind: 'failed', reason: 'fatal: refusing to merge unrelated histories' });
    assert.deepEqual(mergeTreeOutcome({ status: null, stdout: '', stderr: '' }), { kind: 'failed', reason: 'git merge-tree exited without a code' });
  });
});

describe('pullConflicts', () => {
  it("names the conflicting files of the pull request's fetched head against the remote's default branch", () => {
    const git = new FakePullGit();
    git.merges.set('base+head', { kind: 'conflicts', files: ['src/a.ts'] });
    assert.deepEqual(pullConflicts(git, '/repo/web', WEB_7, undefined), { kind: 'conflicts', base: 'origin/main', baseSha: 'base', headSha: 'head', files: ['src/a.ts'] });
    assert.deepEqual(git.log, ['remote /repo/web origin', 'fetch /repo/web origin 7', 'merge-tree /repo/web base head']);
  });

  it('checks against the base it is given, and refuses a base origin lacks', () => {
    const git = new FakePullGit();
    git.originBranches.set('release', 'rel');
    assert.deepEqual(pullConflicts(git, '/repo/web', WEB_7, 'release'), { kind: 'clean', base: 'origin/release', baseSha: 'rel', headSha: 'head' });
    assert.deepEqual(pullConflicts(git, '/repo/web', WEB_7, 'gone'), { kind: 'failed', reason: 'origin has no branch gone' });
  });

  it('fetches nothing in a clone of another repository or with no GitHub origin', () => {
    const git = new FakePullGit();
    git.repos.set('/repo/api', 'acme/api');
    assert.deepEqual(pullConflicts(git, '/repo/api', WEB_7, undefined), { kind: 'failed', reason: 'run it in a clone of acme/web: this folder is a clone of acme/api' });
    assert.deepEqual(pullConflicts(git, '/tmp', WEB_7, undefined), { kind: 'failed', reason: 'run it in a clone of acme/web: this folder has no origin remote on GitHub' });
    assert.deepEqual(git.log, ['remote /repo/api origin', 'remote /tmp origin']);
  });

  it("says the fetch failed, such as for a pull request origin does not have, and merges nothing", () => {
    const git = new FakePullGit();
    assert.deepEqual(pullConflicts(git, '/repo/web', { repo: 'acme/web', number: 8 }, undefined), { kind: 'failed', reason: "fetching pull request 8 failed: couldn't find remote ref refs/pull/8/head" });
    git.fetchFails = 'could not read from remote';
    assert.deepEqual(pullConflicts(git, '/repo/web', WEB_7, undefined), { kind: 'failed', reason: 'fetching pull request 7 failed: could not read from remote' });
    assert.equal(git.log.some((line) => line.startsWith('merge-tree')), false);
  });

  it('passes a failed merge on', () => {
    const git = new FakePullGit();
    git.merges.set('base+head', { kind: 'failed', reason: 'fatal: refusing to merge unrelated histories' });
    assert.deepEqual(pullConflicts(git, '/repo/web', WEB_7, undefined), { kind: 'failed', reason: 'fatal: refusing to merge unrelated histories' });
  });
});

/** Commits `content` at `path` on the checked-out branch. */
function commit(repo: TempRepo, path: string, content: string, message: string): void {
  repo.write(path, content);
  repo.git('add', '--', path);
  repo.git('commit', '-qm', message);
}

describe('GIT_PULLS', () => {
  it("reads the GitHub repository of a remote's URL, and none for a missing remote", () => {
    const repo = new TempRepo('pulls-remote').init();
    try {
      repo.git('remote', 'add', 'origin', 'git@github.com:Acme/Web.git');
      assert.equal(GIT_PULLS.remoteRepo(repo.dir, 'origin'), 'acme/web');
      assert.equal(GIT_PULLS.remoteRepo(repo.dir, 'upstream'), undefined);
    } finally {
      repo.remove();
    }
  });

  it("fetches a pull request's head into teamrig's ref and names the files it conflicts on, leaving the checkout as it was", () => {
    const repo = new TempRepo('pulls-conflicts').init();
    try {
      const origin = join(repo.outside, 'origin.git');
      repo.git('init', '-q', '--bare', '-b', 'main', origin);
      repo.git('symbolic-ref', 'HEAD', 'refs/heads/main');
      commit(repo, 'a.txt', 'one\n', 'one');
      commit(repo, 'b.txt', 'one\n', 'two');
      repo.git('remote', 'add', 'origin', origin);
      repo.git('push', '-q', 'origin', 'main');
      repo.git('switch', '-q', '-c', 'theirs');
      commit(repo, 'a.txt', 'theirs\n', 'theirs a');
      commit(repo, 'c.txt', 'new\n', 'theirs c');
      repo.git('push', '-q', 'origin', 'theirs:refs/pull/7/head');
      repo.git('switch', '-q', 'main');
      repo.git('branch', '-q', '-D', 'theirs');
      commit(repo, 'a.txt', 'ours\n', 'ours a');
      repo.git('push', '-q', 'origin', 'main');
      const head = repo.git('rev-parse', 'HEAD').trim();

      assert.deepEqual(GIT_PULLS.fetchPull(repo.dir, 'origin', 7), { ok: true });
      assert.equal(GIT_PULLS.defaultBranch(repo.dir, 'origin'), 'main');
      const base = GIT_PULLS.sha(repo.dir, 'origin/main');
      const pull = GIT_PULLS.sha(repo.dir, pullRef(7));
      assert.equal(base, head);
      assert.ok(base !== undefined && pull !== undefined);
      assert.deepEqual(GIT_PULLS.mergeTree(repo.dir, base, pull), { kind: 'conflicts', files: ['a.txt'] });
      assert.deepEqual(GIT_PULLS.mergeTree(repo.dir, base, base), { kind: 'clean' });
      assert.equal(repo.git('rev-parse', 'HEAD').trim(), head);
      assert.equal(repo.git('status', '--porcelain'), '');
      assert.equal(GIT_PULLS.fetchPull(repo.dir, 'origin', 8).ok, false);
    } finally {
      repo.remove();
    }
  });
});
