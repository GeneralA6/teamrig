import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGit, GitError, gitSyncIn, STDOUT_TAIL_LINES } from './git.ts';
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
      assert.equal(error.stdoutTail, '');
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
  // Git passes a pre-push hook's stdout through as its own stdout: 2 MiB of it stands for the local gate the hook runs.
  const node = process.execPath.replaceAll('\\', '/');
  const hook = repo.write('.git/hooks/pre-push', `#!/bin/sh\n"${node}" -e "process.stdout.write('x'.repeat(2 * 1024 * 1024))"\n`);
  // Git on Linux and macOS skips a hook without the execute bit, and its push would then print nothing.
  chmodSync(hook, 0o755);

  it('pushes through a pre-push hook that prints past the default 1 MiB, where a default buffer ends in ENOBUFS (T3012)', () => {
    assert.throws(
      () => execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/t-default'], { cwd: repo.dir, env: repo.env, encoding: 'utf8' }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOBUFS',
    );
    gitSyncIn(repo.dir, repo.env)(['push', '-q', 'origin', 'HEAD:refs/heads/t-bounded']);
    assert.match(repo.git('ls-remote', '--heads', 'origin', 'refs/heads/t-bounded'), /\trefs\/heads\/t-bounded\n$/);
  });

  it('returns stdout as text and throws a GitError with no stdout tail when git fails silently', () => {
    const git = gitSyncIn(repo.dir, repo.env);
    assert.equal(git(['rev-parse', 'HEAD']).trim(), repo.git('rev-parse', 'HEAD').trim());
    const args = ['rev-parse', '--verify', '-q', 'teamrig-no-such-ref'];
    assert.throws(() => git(args), (error: unknown) => {
      assert.ok(error instanceof GitError);
      assert.deepEqual(error.args, args);
      assert.equal(error.stdoutTail, '');
      assert.equal(error.message, `git ${args.join(' ')} failed: ${String(error.cause)}`);
      return true;
    });
  });
});

describe('a push its pre-push hook refuses', () => {
  const repo = new TempRepo('git-refused').init();
  after(() => repo.remove());
  const origin = join(repo.outside, 'origin.git');
  repo.git('init', '-q', '--bare', origin);
  repo.git('remote', 'add', 'origin', origin);
  repo.write('a.txt', 'a\n');
  repo.git('add', 'a.txt');
  repo.git('commit', '-q', '-m', 'a');
  // The local gate's shape: many lines of checks on stdout, its reason last, then a failing exit.
  const node = process.execPath.replaceAll('\\', '/');
  const gate = "for (let i = 1; i <= 100; i++) console.log('check ' + i); console.log('local checks: REFUSED coverage gate failed'); process.exit(1)";
  chmodSync(repo.write('.git/hooks/pre-push', `#!/bin/sh\n"${node}" -e "${gate}"\n`), 0o755);
  const push = ['push', '-q', 'origin', 'HEAD:refs/heads/t-refused'];
  const tail = [...Array.from({ length: STDOUT_TAIL_LINES - 1 }, (_, i) => `check ${100 - STDOUT_TAIL_LINES + 2 + i}`), 'local checks: REFUSED coverage gate failed'].join('\n');

  it('names the last lines the hook printed, its REFUSED reason with them (T4130)', () => {
    assert.throws(() => gitSyncIn(repo.dir, repo.env)(push), (error: unknown) => {
      assert.ok(error instanceof GitError);
      assert.equal(error.stdoutTail, tail);
      assert.match(error.message, /^git push -q origin HEAD:refs\/heads\/t-refused failed: error: failed to push some refs/);
      assert.ok(error.message.endsWith(`\n${tail}`), error.message);
      assert.doesNotMatch(error.message, new RegExp(`^check ${100 - STDOUT_TAIL_LINES + 1}$`, 'm'));
      return true;
    });
  });
});
