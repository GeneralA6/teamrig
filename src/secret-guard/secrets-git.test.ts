import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { TempRepo } from '../../tools/lib/temp-repo.ts';
import { MAX_TAG_DEPTH, gitSecrets } from './secrets-git.ts';

/** Runs git in the repo under `env`, as a hook's git would, and fails the test when it fails. */
function gitIn(repo: TempRepo, env: NodeJS.ProcessEnv, ...args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd: repo.dir, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

const slashed = (path: string | undefined): string | undefined => path?.replaceAll('\\', '/');

describe('gitSecrets', () => {
  it('reads what the staged change adds from the top folder, before the first commit and with diff.relative set', () => {
    const repo = new TempRepo('secrets-staged').init();
    try {
      const git = gitSecrets(repo.env);
      repo.write('top.txt', 'first\n');
      repo.git('add', 'top.txt');
      assert.deepEqual(git.staged(repo.dir), { paths: ['top.txt'], lines: [{ file: 'top.txt', line: 1, text: 'first' }] });
      repo.git('commit', '-q', '-m', 'base');
      repo.git('config', 'diff.relative', 'true');
      repo.write('top.txt', 'first\nsecond\n');
      repo.write('src/app.txt', 'one\n');
      repo.git('add', '-A');
      assert.deepEqual(git.staged(join(repo.dir, 'src')), {
        paths: ['src/app.txt', 'top.txt'],
        lines: [
          { file: 'src/app.txt', line: 1, text: 'one' },
          { file: 'top.txt', line: 2, text: 'second' },
        ],
      });
      assert.equal(slashed(git.root(join(repo.dir, 'src'))), slashed(repo.dir));
    } finally {
      repo.remove();
    }
  });

  it("reads the index a hook's GIT_INDEX_FILE names, as `git commit -a` stages into a temporary one", () => {
    const repo = new TempRepo('secrets-index').init();
    try {
      repo.write('kept.txt', 'kept\n');
      repo.git('add', 'kept.txt');
      repo.git('commit', '-q', '-m', 'base');
      const hookEnv = { ...repo.env, GIT_INDEX_FILE: join(repo.outside, 'next-index') };
      gitIn(repo, hookEnv, 'read-tree', 'HEAD');
      repo.write('kept.txt', 'kept\nadded\n');
      gitIn(repo, hookEnv, 'add', 'kept.txt');
      assert.deepEqual(gitSecrets(hookEnv).staged(repo.dir), { paths: ['kept.txt'], lines: [{ file: 'kept.txt', line: 2, text: 'added' }] });
      assert.deepEqual(gitSecrets(repo.env).staged(repo.dir), { paths: [], lines: [] });
    } finally {
      repo.remove();
    }
  });

  it('lists the commits of a range with their messages and adds, the first commit too, and knows which commits it holds', () => {
    const repo = new TempRepo('secrets-log').init();
    try {
      const git = gitSecrets(repo.env);
      repo.write('a.txt', 'one\n');
      repo.git('add', 'a.txt');
      repo.git('commit', '-q', '-m', 'first');
      const first = repo.git('rev-parse', 'HEAD').trim();
      repo.write('a.txt', 'one\ntwo\n');
      repo.git('commit', '-q', '-a', '-m', 'second\n\nbody line');
      const second = repo.git('rev-parse', 'HEAD').trim();
      assert.deepEqual(git.commits(repo.dir, { kind: 'after', base: first, tip: second }), [
        { sha: second, message: 'second\n\nbody line\n', paths: ['a.txt'], lines: [{ file: 'a.txt', line: 2, text: 'two' }] },
      ]);
      repo.git('config', 'log.showRoot', 'false');
      const unpushed = git.commits(repo.dir, { kind: 'unpushed', tip: second, remote: 'origin' });
      assert.deepEqual(
        unpushed?.map(({ sha, lines }) => ({ sha, lines })),
        [
          { sha: second, lines: [{ file: 'a.txt', line: 2, text: 'two' }] },
          { sha: first, lines: [{ file: 'a.txt', line: 1, text: 'one' }] },
        ],
      );
      assert.equal(git.isCommit(repo.dir, second), true);
      assert.equal(git.isCommit(repo.dir, 'f'.repeat(40)), false);
      assert.equal(git.isCommit(repo.dir, '--all'), false);
    } finally {
      repo.remove();
    }
  });

  it("lists what a merge's resolution added past git's own merge of its parents, and nothing for a clean merge", () => {
    const repo = new TempRepo('secrets-merge').init();
    try {
      const git = gitSecrets(repo.env);
      repo.write('a.txt', 'base\n');
      repo.git('add', 'a.txt');
      repo.git('commit', '-q', '-m', 'base');
      const base = repo.git('rev-parse', 'HEAD').trim();
      repo.git('checkout', '-q', '-b', 'side');
      repo.write('a.txt', 'side\n');
      repo.git('commit', '-q', '-a', '-m', 'side');
      repo.git('checkout', '-q', '-');
      repo.write('a.txt', 'main\n');
      repo.git('commit', '-q', '-a', '-m', 'main');
      const conflict = spawnSync('git', ['merge', '-q', 'side'], { cwd: repo.dir, env: repo.env, encoding: 'utf8' });
      assert.equal(conflict.status, 1, 'the two sides conflict');
      repo.write('a.txt', 'main\nside\nresolved extra\n');
      repo.git('commit', '-q', '-a', '--no-edit');
      const evil = repo.git('rev-parse', 'HEAD').trim();
      repo.git('checkout', '-q', '-b', 'clean');
      repo.write('c.txt', 'clean side\n');
      repo.git('add', 'c.txt');
      repo.git('commit', '-q', '-m', 'clean side');
      repo.git('checkout', '-q', '-');
      repo.git('merge', '-q', '--no-ff', '--no-edit', 'clean');
      const clean = repo.git('rev-parse', 'HEAD').trim();
      const merges = git.commits(repo.dir, { kind: 'after', base, tip: clean })?.filter(({ sha }) => sha === evil || sha === clean);
      assert.deepEqual(
        merges?.map(({ sha, paths, lines }) => ({ sha, paths, lines })),
        [
          { sha: clean, paths: [], lines: [] },
          { sha: evil, paths: ['a.txt'], lines: [{ file: 'a.txt', line: 3, text: 'resolved extra' }] },
        ],
      );
    } finally {
      repo.remove();
    }
  });

  it("reads a tag's message and each tag it points through, outermost first, none for a commit, and fails past the depth", () => {
    const repo = new TempRepo('secrets-tags').init();
    try {
      const git = gitSecrets(repo.env);
      const tag = (name: string, target: string, message: string): string => {
        repo.git('-c', 'advice.nestedTag=false', 'tag', '-a', name, target, '-m', message);
        return repo.git('rev-parse', name).trim();
      };
      repo.write('a.txt', 'one\n');
      repo.git('add', 'a.txt');
      repo.git('commit', '-q', '-m', 'first');
      const head = repo.git('rev-parse', 'HEAD').trim();
      const inner = tag('v1', head, 'release one\n\nbody line');
      const outer = tag('outer', 'v1', 'outer');
      assert.deepEqual(git.tagMessages(repo.dir, outer), [
        { sha: outer, message: 'outer\n' },
        { sha: inner, message: 'release one\n\nbody line\n' },
      ]);
      assert.deepEqual(git.tagMessages(repo.dir, head), []);
      let top = outer;
      for (let depth = 3; depth <= MAX_TAG_DEPTH; depth += 1) {
        top = tag(`t${depth}`, top, `t${depth}`);
      }
      assert.equal(git.tagMessages(repo.dir, top)?.length, MAX_TAG_DEPTH);
      assert.equal(git.tagMessages(repo.dir, tag('deepest', top, 'deepest')), undefined);
      assert.equal(git.tagMessages(repo.dir, 'f'.repeat(40)), undefined);
      assert.equal(git.tagMessages(repo.dir, '--all'), undefined);
    } finally {
      repo.remove();
    }
  });

  it("finds the hooks folder from any folder of the repository: the git folder's, or core.hooksPath from the top folder", () => {
    const repo = new TempRepo('secrets-hooks').init();
    try {
      const git = gitSecrets(repo.env);
      repo.write('src/app.txt', 'one\n');
      const sub = join(repo.dir, 'src');
      assert.equal(slashed(git.hooksDir(sub)), slashed(join(repo.dir, '.git', 'hooks')));
      repo.git('config', 'core.hooksPath', '.githooks');
      assert.equal(slashed(git.hooksDir(sub)), slashed(join(repo.dir, '.githooks')));
      const shared = join(repo.outside, 'shared-hooks');
      repo.git('config', 'core.hooksPath', shared);
      assert.equal(slashed(git.hooksDir(sub)), slashed(shared));
    } finally {
      repo.remove();
    }
  });

  it('reads nothing outside a repository, so the scan fails closed', () => {
    const repo = new TempRepo('secrets-none');
    try {
      const git = gitSecrets(repo.env);
      assert.equal(git.root(repo.outside), undefined);
      assert.equal(git.staged(repo.outside), undefined);
      assert.equal(git.hooksDir(repo.outside), undefined);
      assert.equal(git.commits(repo.outside, { kind: 'unpushed', tip: 'f'.repeat(40), remote: 'origin' }), undefined);
      assert.equal(git.tagMessages(repo.outside, 'f'.repeat(40)), undefined);
    } finally {
      repo.remove();
    }
  });
});
