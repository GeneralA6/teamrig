import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FakeGit } from '../lib/fake-git.ts';
import { isBinary, messageFileInput, stagedInputs, treeInputs, type ReadFile } from './sources.ts';

const missing = (path: string): Error => Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' });

function fakeFiles(files: Readonly<Record<string, string>>): ReadFile {
  return async (path) => {
    const content = files[path];
    if (content === undefined) {
      throw missing(path);
    }
    return Buffer.from(content, 'utf8');
  };
}

describe('stagedInputs', () => {
  it('reads each staged file from the index and adds its path as an input', async () => {
    const git = new FakeGit({
      'diff --cached --name-only -z --diff-filter=ACMR': 'a.txt\0dir/b.md\0',
      'show :a.txt': 'alpha',
      'show :dir/b.md': 'bravo',
    });

    const inputs = await stagedInputs(git);

    assert.deepEqual(
      inputs.map((input) => [input.source, input.content.toString()]),
      [
        ['a.txt (path)', 'a.txt'],
        ['a.txt', 'alpha'],
        ['dir/b.md (path)', 'dir/b.md'],
        ['dir/b.md', 'bravo'],
      ],
    );
  });
});

describe('treeInputs', () => {
  it('reads tracked files from the working tree and skips ones deleted on disk', async () => {
    const root = join('/', 'repo');
    const git = new FakeGit({ 'rev-parse --show-toplevel': `${root}\n`, 'ls-files -z': 'kept.txt\0gone.txt\0' });
    const readFile = fakeFiles({ [join(root, 'kept.txt')]: 'kept' });

    const inputs = await treeInputs(git, readFile);

    assert.deepEqual(
      inputs.map((input) => input.source),
      ['kept.txt (path)', 'kept.txt', 'gone.txt (path)'],
    );
  });

  it('propagates read errors other than a missing file', async () => {
    const git = new FakeGit({ 'rev-parse --show-toplevel': '/repo\n', 'ls-files -z': 'locked.txt\0' });
    const denied: ReadFile = async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    await assert.rejects(treeInputs(git, denied), /denied/);
  });
});

describe('messageFileInput', () => {
  it("drops git's comment lines", () => {
    const input = messageFileInput('MSG', 'subject\n# Please enter the commit message\nbody\n');
    assert.equal(input.content, 'subject\nbody\n');
  });
});

describe('isBinary', () => {
  it('treats a buffer with a NUL byte as binary and text as not', () => {
    assert.equal(isBinary(Buffer.from([0x50, 0x00, 0x51])), true);
    assert.equal(isBinary(Buffer.from('plain text')), false);
    assert.equal(isBinary('a string is never binary'), false);
  });
});
