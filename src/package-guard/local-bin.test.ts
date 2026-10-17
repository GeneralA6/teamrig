import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { hasLocalBin } from './local-bin.ts';

const WORK = resolve('/', 'work');
const APP = join(WORK, 'app');

describe('hasLocalBin', () => {
  it("finds a bin in the folder's node_modules/.bin, as a bare file or a Windows shim, without case", async () => {
    for (const name of ['eslint', 'eslint.cmd', 'ESLint.ps1']) {
      const files = new MemoryFiles({ [join(APP, 'node_modules', '.bin', name)]: '' });
      assert.equal(await hasLocalBin(files, APP, 'eslint'), true, name);
    }
  });

  it("finds an ancestor's bin, as a workspace package runs its root's", async () => {
    const files = new MemoryFiles({ [join(WORK, 'node_modules', '.bin', 'tsc')]: '' });
    assert.equal(await hasLocalBin(files, join(APP, 'packages', 'a'), 'tsc'), true);
  });

  it('finds none for a bin installed nowhere up to the root, or only under another name', async () => {
    const files = new MemoryFiles({ [join(APP, 'node_modules', '.bin', 'eslint-config')]: '', [join(APP, 'node_modules', 'eslint', 'package.json')]: '{}' });
    assert.equal(await hasLocalBin(files, APP, 'eslint'), false);
  });

  it('walks a Windows folder by Windows rules on any host', async () => {
    const files = new MemoryFiles({ 'D:\\w\\node_modules\\.bin\\tsc.cmd': '' });
    assert.equal(await hasLocalBin(files, 'D:\\w\\app', 'tsc'), true);
    assert.equal(await hasLocalBin(files, 'D:\\other', 'tsc'), false);
  });
});
