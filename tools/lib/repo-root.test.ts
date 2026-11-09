import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { takeRoot, TOOLS_REPO } from './repo-root.ts';

describe('TOOLS_REPO', () => {
  it('is the checkout that holds these tools', () => {
    assert.ok(existsSync(join(TOOLS_REPO, 'tools', 'lib', 'repo-root.ts')), TOOLS_REPO);
    assert.ok(existsSync(join(TOOLS_REPO, 'package.json')), TOOLS_REPO);
  });
});

describe('takeRoot', () => {
  it('is the tools repo, not the cwd, when no --root is given, and keeps every argument', () => {
    assert.deepEqual(takeRoot(['--check']), { root: TOOLS_REPO, rest: ['--check'] });
    assert.deepEqual(takeRoot([]), { root: TOOLS_REPO, rest: [] });
  });

  it('takes --root and its folder out wherever they stand, resolving the folder from the cwd', () => {
    assert.deepEqual(takeRoot(['--root', 'repo', '--check']), { root: resolve('repo'), rest: ['--check'] });
    assert.deepEqual(takeRoot(['--check', '--root', 'repo', '--fix']), { root: resolve('repo'), rest: ['--check', '--fix'] });
  });

  it('refuses --root with no folder after it', () => {
    assert.throws(() => takeRoot(['--root']), { message: '--root needs a folder' });
    assert.throws(() => takeRoot(['--root', '--check']), { message: '--root needs a folder' });
  });

  it('refuses --root given twice', () => {
    assert.throws(() => takeRoot(['--root', 'a', '--root', 'b']), { message: '--root is given twice' });
  });
});
