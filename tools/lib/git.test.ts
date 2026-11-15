import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGit, GitError, gitSyncIn } from './git.ts';
import { TempRepo } from './temp-repo.ts';

describe('createGit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamrig-git-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const git = createGit(dir);

  it('returns stdout as text and as raw bytes', async () => {
    assert.match(await git.text(['--version']), /^git version /);
    const bytes = await git.bytes(['--version']);
    assert.ok(Buffer.isBuffer(bytes));
    assert.match(bytes.toString('utf8'), /^git version /);
  });

  it('rejects a failed command with a GitError that carries its args and stderr', async () => {
    const args = ['rev-parse', '--verify', 'teamrig-no-such-ref'];
    await assert.rejects(git.text(args), (error: unknown) => {
      assert.ok(error instanceof GitError);
      assert.equal(error.name, 'GitError');
      assert.deepEqual(error.args, args);
      assert.notEqual(error.stderr.trim(), '');
      assert.equal(error.message, `git ${args.join(' ')} failed: ${error.stderr.trim()}`);
      assert.ok(error.cause instanceof Error);
      return true;
    });
  });

  it('names the exit error when git fails without a word on stderr', async () => {
    const args = ['config', '--get', 'teamrig.no-such-key'];
    await assert.rejects(git.bytes(args), (error: unknown) => {
      assert.ok(error instanceof GitError);
      assert.equal(error.stderr, '');
      assert.equal(error.message, `git ${args.join(' ')} failed: ${String(error.cause)}`);
      return true;
    });
  });
});

describe('gitSyncIn', () => {
  const repo = new TempRepo('git-sync').init();
  after(() => repo.remove());
  const origin = join(repo.outside, 'origin.git');
  repo.git('init', '-q', '--bare', origin);
  repo.git('remote', 'add', 'origin', origin);
  repo.write('a.txt', 'a\n');
  repo.git('add', 'a.txt');
  repo.git('commit', '-q', '-m', 'a');
  // Git sends a hook's stdout to its own stderr: 2 MiB of it stands for the local gate the pre-push hook runs.
  const node = process.execPath.replaceAll('\\', '/');
  repo.write('.git/hooks/pre-push', `#!/bin/sh\n"${node}" -e "process.stdout.write('x'.repeat(2 * 1024 * 1024))"\n`);

  it('pushes through a pre-push hook that prints past the default 1 MiB, where a default buffer ends in ENOBUFS (T3012)', () => {
    assert.throws(
      () => execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/t-default'], { cwd: repo.dir, env: repo.env, encoding: 'utf8' }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOBUFS',
    );
    gitSyncIn(repo.dir, repo.env)(['push', '-q', 'origin', 'HEAD:refs/heads/t-bounded']);
    assert.match(repo.git('ls-remote', '--heads', 'origin', 'refs/heads/t-bounded'), /\trefs\/heads\/t-bounded\n$/);
  });

  it('returns stdout as text and throws when git fails', () => {
    const git = gitSyncIn(repo.dir, repo.env);
    assert.equal(git(['rev-parse', 'HEAD']).trim(), repo.git('rev-parse', 'HEAD').trim());
    assert.throws(() => git(['rev-parse', '--verify', '-q', 'teamrig-no-such-ref']));
  });
});
