import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGit, GitError } from './git.ts';

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
