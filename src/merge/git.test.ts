import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { TempRepo } from '../../tools/lib/temp-repo.ts';
import { GIT_MERGE as git, ORIGIN } from './git.ts';

/** A repo on `main`, pushed to a bare origin beside it, with `origin/HEAD` set; returns the repo and the origin's folder. */
function repoWithOrigin(prefix: string): { repo: TempRepo; origin: string } {
  const repo = new TempRepo(prefix).init();
  const origin = join(repo.outside, 'origin.git');
  repo.git('init', '-q', '--bare', '-b', 'main', origin);
  repo.git('symbolic-ref', 'HEAD', 'refs/heads/main');
  commit(repo, 'app.txt', 'one\n', 'one');
  repo.git('remote', 'add', 'origin', origin);
  repo.git('push', '-q', '-u', 'origin', 'main');
  repo.git('remote', 'set-head', 'origin', 'main');
  return { repo, origin };
}

/** Commits `content` at `path` on the checked-out branch; returns the new commit. */
function commit(repo: TempRepo, path: string, content: string, message: string): string {
  repo.write(path, content);
  repo.git('add', '--', path);
  repo.git('commit', '-qm', message);
  return repo.git('rev-parse', 'HEAD').trim();
}

/** Lands a commit on origin's main as another session would, from a branch the repo then drops; returns the commit. */
function landElsewhere(repo: TempRepo, path: string, content: string): string {
  const back = repo.git('symbolic-ref', '--short', 'HEAD').trim();
  repo.git('switch', '-q', '-c', 'elsewhere', 'origin/main');
  const sha = commit(repo, path, content, `elsewhere ${path}`);
  repo.git('push', '-q', 'origin', 'elsewhere:main');
  repo.git('switch', '-q', back);
  repo.git('branch', '-q', '-D', 'elsewhere');
  return sha;
}

function sameFolder(actual: string | undefined, expected: string): void {
  assert.equal(actual === undefined ? undefined : resolve(actual), resolve(expected));
}

describe('GIT_MERGE where a checkout is', () => {
  it('tells the main checkout from a linked worktree, and a branch from a detached HEAD', () => {
    const { repo } = repoWithOrigin('merge-where');
    const linked = join(repo.outside, 'feat');
    try {
      repo.git('worktree', 'add', '-q', '-b', 'feat', linked);
      const main = git.checkoutOf(repo.dir);
      sameFolder(main?.top, repo.dir);
      sameFolder(main?.mainCheckout, repo.dir);
      assert.equal(main?.branch, 'main');
      assert.equal(main?.linked, false);
      const worktree = git.checkoutOf(linked);
      sameFolder(worktree?.top, linked);
      sameFolder(worktree?.mainCheckout, repo.dir);
      assert.equal(worktree?.branch, 'feat');
      assert.equal(worktree?.linked, true);
      repo.git('switch', '-q', '--detach');
      assert.equal(git.checkoutOf(repo.dir)?.branch, undefined);
    } finally {
      repo.remove();
    }
  });

  it('lists changes, untracked files only when asked', () => {
    const { repo } = repoWithOrigin('merge-changes');
    try {
      assert.deepEqual(git.changes(repo.dir, true), []);
      repo.write('new.txt', 'new\n');
      assert.deepEqual(git.changes(repo.dir, true), ['?? new.txt']);
      assert.deepEqual(git.changes(repo.dir, false), []);
      repo.write('app.txt', 'two\n');
      assert.deepEqual(git.changes(repo.dir, false), [' M app.txt']);
    } finally {
      repo.remove();
    }
  });

  it("finds origin's default branch from origin/HEAD, else main or master", () => {
    const { repo } = repoWithOrigin('merge-default');
    try {
      repo.git('push', '-q', 'origin', 'main:trunk');
      repo.git('fetch', '-q', 'origin');
      repo.git('remote', 'set-head', 'origin', 'trunk');
      assert.equal(git.defaultBranch(repo.dir, ORIGIN), 'trunk');
      repo.git('remote', 'set-head', 'origin', '--delete');
      assert.equal(git.defaultBranch(repo.dir, ORIGIN), 'main');
      repo.git('update-ref', '-d', 'refs/remotes/origin/main');
      assert.equal(git.defaultBranch(repo.dir, ORIGIN), 'main');
      repo.git('update-ref', 'refs/remotes/origin/master', 'HEAD');
      assert.equal(git.defaultBranch(repo.dir, ORIGIN), 'master');
    } finally {
      repo.remove();
    }
  });
});

describe('GIT_MERGE reading the ssh command', () => {
  it("reads core.sshCommand from git's config, and no longer once it is unset", () => {
    const { repo } = repoWithOrigin('merge-ssh');
    try {
      repo.git('config', 'core.sshCommand', 'ssh -i deploy_key');
      assert.equal(git.sshCommand(repo.dir), 'ssh -i deploy_key');
      repo.git('config', '--unset', 'core.sshCommand');
      assert.notEqual(git.sshCommand(repo.dir), 'ssh -i deploy_key');
    } finally {
      repo.remove();
    }
  });
});

describe('GIT_MERGE reading origin and a range', () => {
  it("reads origin's branch from origin itself, and the local copy only after a fetch", () => {
    const { repo } = repoWithOrigin('merge-remote');
    try {
      const before = repo.git('rev-parse', 'HEAD').trim();
      const landed = landElsewhere(repo, 'other.txt', 'other\n');
      repo.git('update-ref', 'refs/remotes/origin/main', before);
      assert.equal(git.remoteHead(repo.dir, ORIGIN, 'main'), landed);
      assert.equal(git.remoteHead(repo.dir, ORIGIN, 'none'), undefined);
      assert.equal(git.sha(repo.dir, 'origin/main'), before);
      assert.deepEqual(git.fetch(repo.dir, ORIGIN), { ok: true });
      assert.equal(git.sha(repo.dir, 'origin/main'), landed);
      assert.equal(git.sha(repo.dir, 'no-such-ref'), undefined);
    } finally {
      repo.remove();
    }
  });

  it('reads, fetches and follows a remote beside origin, such as the project a fork was made from', () => {
    const { repo } = repoWithOrigin('merge-upstream');
    try {
      const upstream = join(repo.outside, 'upstream.git');
      repo.git('init', '-q', '--bare', '-b', 'trunk', upstream);
      repo.git('remote', 'add', 'upstream', upstream);
      repo.git('switch', '-q', '-c', 'up');
      const landed = commit(repo, 'up.txt', 'up\n', 'up');
      repo.git('push', '-q', 'upstream', 'up:trunk');
      repo.git('switch', '-q', 'main');
      repo.git('branch', '-q', '-D', 'up');
      assert.equal(git.remoteHead(repo.dir, 'upstream', 'trunk'), landed);
      assert.equal(git.remoteHead(repo.dir, ORIGIN, 'trunk'), undefined);
      assert.deepEqual(git.fetch(repo.dir, 'upstream'), { ok: true });
      assert.equal(git.fetch(repo.dir, 'none').ok, false);
      repo.git('remote', 'set-head', 'upstream', 'trunk');
      assert.equal(git.defaultBranch(repo.dir, 'upstream'), 'trunk');
      assert.equal(git.defaultBranch(repo.dir, ORIGIN), 'main');
      assert.equal(git.sha(repo.dir, 'upstream/trunk'), landed);
      assert.deepEqual(git.updateLocalBranch(repo.dir, 'upstream', 'trunk'), { kind: 'updated' });
      assert.equal(git.sha(repo.dir, 'refs/heads/trunk'), landed);
    } finally {
      repo.remove();
    }
  });

  it("reads a range's commits, paths and files at either end", () => {
    const { repo } = repoWithOrigin('merge-range');
    try {
      repo.git('switch', '-q', '-c', 'feat');
      const first = commit(repo, 'package.json', '{"name": "app"}\n', 'manifest');
      const second = commit(repo, 'src/a b.ts', 'export {};\n', 'source');
      const base = git.mergeBase(repo.dir, 'origin/main', 'HEAD');
      assert.equal(base, git.sha(repo.dir, 'origin/main'));
      assert.deepEqual(git.commits(repo.dir, 'origin/main', 'HEAD'), [first, second]);
      assert.deepEqual(git.changedPaths(repo.dir, base ?? '', 'HEAD'), ['package.json', 'src/a b.ts']);
      assert.equal(git.fileAt(repo.dir, base ?? '', 'package.json'), undefined);
      assert.equal(git.fileAt(repo.dir, 'HEAD', 'package.json'), '{"name": "app"}\n');
      assert.equal(git.isAncestor(repo.dir, 'origin/main', 'HEAD'), true);
      assert.equal(git.isAncestor(repo.dir, 'HEAD', 'origin/main'), false);
      assert.equal(git.changedPaths(repo.dir, 'no-such-ref', 'HEAD'), undefined);
    } finally {
      repo.remove();
    }
  });

  it('reads the tree a commit makes, the same for two commits of the same files', () => {
    const { repo } = repoWithOrigin('merge-tree');
    try {
      const tree = git.treeOf(repo.dir, 'HEAD');
      assert.equal(tree, repo.git('rev-parse', 'HEAD^{tree}').trim());
      repo.git('commit', '-q', '--allow-empty', '-m', 'empty');
      assert.equal(git.treeOf(repo.dir, 'HEAD'), tree);
      assert.notEqual(git.sha(repo.dir, 'HEAD'), git.sha(repo.dir, 'HEAD~1'));
      assert.equal(git.treeOf(repo.dir, 'no-such-ref'), undefined);
    } finally {
      repo.remove();
    }
  });
});

describe('GIT_MERGE rebase', () => {
  it('rebases the branch onto a moved main', () => {
    const { repo } = repoWithOrigin('merge-rebase');
    try {
      repo.git('switch', '-q', '-c', 'feat');
      commit(repo, 'feat.txt', 'feat\n', 'feat');
      landElsewhere(repo, 'other.txt', 'other\n');
      git.fetch(repo.dir, ORIGIN);
      assert.deepEqual(git.rebase(repo.dir, 'origin/main'), { ok: true });
      assert.equal(git.isAncestor(repo.dir, 'origin/main', 'HEAD'), true);
    } finally {
      repo.remove();
    }
  });

  it('aborts a rebase that stops on a conflict and names the paths, leaving the branch as it was', () => {
    const { repo } = repoWithOrigin('merge-conflict');
    try {
      repo.git('switch', '-q', '-c', 'feat');
      const mine = commit(repo, 'app.txt', 'mine\n', 'mine');
      landElsewhere(repo, 'app.txt', 'theirs\n');
      git.fetch(repo.dir, ORIGIN);
      const stopped = git.rebase(repo.dir, 'origin/main');
      assert.deepEqual(stopped, { ok: false, reason: 'rebase onto origin/main stopped (conflicts in app.txt); aborted, the branch is as it was' });
      assert.equal(git.sha(repo.dir, 'HEAD'), mine);
      assert.equal(git.checkoutOf(repo.dir)?.branch, 'feat');
      assert.deepEqual(git.changes(repo.dir, true), []);
    } finally {
      repo.remove();
    }
  });
});

describe('GIT_MERGE cleanup', () => {
  it("deletes the pushed branch on origin and here, and moves main where it is not checked out", () => {
    const { repo } = repoWithOrigin('merge-cleanup');
    try {
      repo.git('switch', '-q', '-c', 'feat');
      commit(repo, 'feat.txt', 'feat\n', 'feat');
      repo.git('push', '-q', 'origin', 'feat', 'HEAD:main');
      git.fetch(repo.dir, ORIGIN);
      assert.deepEqual(git.deleteRemoteBranch(repo.dir, 'feat'), { ok: true });
      assert.equal(git.remoteHead(repo.dir, ORIGIN, 'feat'), undefined);
      assert.deepEqual(git.detach(repo.dir), { ok: true });
      assert.deepEqual(git.deleteBranch(repo.dir, 'feat'), { ok: true });
      assert.equal(git.sha(repo.dir, 'refs/heads/feat'), undefined);
      assert.deepEqual(git.updateLocalBranch(repo.dir, ORIGIN, 'main'), { kind: 'updated' });
      assert.equal(git.sha(repo.dir, 'refs/heads/main'), git.sha(repo.dir, 'origin/main'));
      assert.deepEqual(git.checkout(repo.dir, 'main'), { ok: true });
      assert.equal(git.checkoutOf(repo.dir)?.branch, 'main');
      assert.equal(git.deleteBranch(repo.dir, 'feat').ok, false);
    } finally {
      repo.remove();
    }
  });

  it('refuses a branch or commit name that git would read as an option, leaving HEAD and the branch as they were', () => {
    const { repo } = repoWithOrigin('merge-dash');
    try {
      const head = git.sha(repo.dir, 'HEAD');
      assert.deepEqual(git.checkout(repo.dir, '--orphan'), { ok: false, reason: 'git checkout refused "--orphan": a branch or commit name never starts with "-"' });
      assert.deepEqual(git.resetTo(repo.dir, '--hard'), { ok: false, reason: 'git reset --keep refused "--hard": a branch or commit name never starts with "-"' });
      assert.equal(git.sha(repo.dir, 'HEAD'), head);
      assert.equal(git.checkoutOf(repo.dir)?.branch, 'main');
    } finally {
      repo.remove();
    }
  });

  it('checks out a branch named like a file in the checkout', () => {
    const { repo } = repoWithOrigin('merge-file-named');
    try {
      repo.git('branch', 'app.txt');
      assert.deepEqual(git.checkout(repo.dir, 'app.txt'), { ok: true });
      assert.equal(git.checkoutOf(repo.dir)?.branch, 'app.txt');
      assert.deepEqual(git.changes(repo.dir, true), []);
    } finally {
      repo.remove();
    }
  });

  it('resets the checkout back to a commit, and refuses where a local change would be lost', () => {
    const { repo } = repoWithOrigin('merge-reset');
    try {
      const before = git.sha(repo.dir, 'HEAD');
      assert.ok(before !== undefined);
      const after = commit(repo, 'other.txt', 'other\n', 'other');
      repo.write('other.txt', 'edited\n');
      assert.equal(git.resetTo(repo.dir, before).ok, false);
      assert.equal(git.sha(repo.dir, 'HEAD'), after);
      repo.git('checkout', '--', 'other.txt');
      assert.deepEqual(git.resetTo(repo.dir, before), { ok: true });
      assert.equal(git.sha(repo.dir, 'HEAD'), before);
      assert.deepEqual(git.changes(repo.dir, true), []);
    } finally {
      repo.remove();
    }
  });

  it('leaves main alone where another checkout has it, and fast-forwards that checkout instead', () => {
    const { repo } = repoWithOrigin('merge-follow');
    const linked = join(repo.outside, 'feat');
    try {
      repo.git('worktree', 'add', '-q', '-b', 'feat', linked);
      const landed = landElsewhere(repo, 'other.txt', 'other\n');
      git.fetch(linked, ORIGIN);
      assert.deepEqual(git.updateLocalBranch(linked, ORIGIN, 'main'), { kind: 'checkedOut' });
      assert.equal(git.isAncestor(repo.dir, 'HEAD', landed), true);
      assert.deepEqual(git.fastForward(repo.dir, landed), { ok: true });
      assert.equal(git.sha(repo.dir, 'HEAD'), landed);
      const side = repo.git('commit-tree', 'HEAD~1^{tree}', '-p', 'HEAD~1', '-m', 'side').trim();
      assert.equal(git.fastForward(repo.dir, side).ok, false);
      assert.equal(git.sha(repo.dir, 'HEAD'), landed);
    } finally {
      repo.remove();
    }
  });
});
