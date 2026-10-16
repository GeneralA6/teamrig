import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NODE_WORKTREE_FILES as files } from './files.ts';

const DIR = realpathSync.native(mkdtempSync(join(tmpdir(), 'teamrig-worktree-files-')));
after(() => rmSync(DIR, { recursive: true, force: true }));

/** A folder with two files in it, the way a main checkout's node_modules holds its packages. */
function target(name: string): string {
  const folder = join(DIR, name);
  mkdirSync(join(folder, 'pkg'), { recursive: true });
  writeFileSync(join(folder, 'pkg', 'index.js'), 'module.exports = 1;\n');
  writeFileSync(join(folder, 'keep.txt'), 'keep\n');
  return folder;
}

/** A directory link to `to`: a junction on Windows, which needs no privilege, and a symlink elsewhere. */
function link(to: string, at: string): string {
  symlinkSync(to, at, 'junction');
  return at;
}

describe('NODE_WORKTREE_FILES', () => {
  it('reads a junction or symlink as a link, not a folder, and names where it points', async () => {
    const modules = target('main-modules');
    const tree = join(DIR, 'tree-a');
    mkdirSync(join(tree, 'src'), { recursive: true });
    writeFileSync(join(tree, 'README.md'), '');
    const at = link(modules, join(tree, 'node_modules'));
    const entries = [...(await files.entries(tree))].sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(entries, [
      { name: 'node_modules', kind: 'link' },
      { name: 'README.md', kind: 'other' },
      { name: 'src', kind: 'folder' },
    ]);
    assert.equal(await files.kindOf(at), 'link');
    assert.equal(await files.kindOf(tree), 'folder');
    assert.equal(realpathSync.native(await files.linkTarget(at)), modules);
    assert.equal(await files.entryCount(at), 2, 'counts through the link');
  });

  it('unlinks the link alone: its target and everything in it survive untouched', async () => {
    const modules = target('kept-modules');
    const at = link(modules, join(DIR, 'tree-b-node_modules'));
    await files.unlinkLink(at);
    assert.equal(await files.kindOf(at), 'missing');
    assert.equal(existsSync(at), false);
    assert.deepEqual(readdirSync(modules).sort(), ['keep.txt', 'pkg']);
    assert.equal(readFileSync(join(modules, 'pkg', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  });

  it('refuses to unlink a real folder, which keeps all it holds', async () => {
    const real = target('real-modules');
    await assert.rejects(files.unlinkLink(real));
    assert.deepEqual(readdirSync(real).sort(), ['keep.txt', 'pkg']);
  });

  it('unlinks a link whose target is gone', async () => {
    const gone = join(DIR, 'gone');
    mkdirSync(gone);
    const at = link(gone, join(DIR, 'dangling'));
    rmSync(gone, { recursive: true });
    assert.equal(await files.kindOf(at), 'link');
    assert.equal(await files.entryCount(at), undefined);
    await files.unlinkLink(at);
    assert.equal(await files.kindOf(at), 'missing');
  });

  it('reads a missing folder as empty and a missing path as missing', async () => {
    const missing = join(DIR, 'no-such-folder');
    assert.deepEqual(await files.entries(missing), []);
    assert.equal(await files.kindOf(missing), 'missing');
    assert.equal(await files.entryCount(missing), undefined);
    assert.equal(await files.canonical(missing), undefined);
  });

  it('counts no entries in a file, and lists none of it', async () => {
    const file = join(DIR, 'plain.txt');
    writeFileSync(file, '');
    assert.equal(await files.entryCount(file), undefined);
    assert.equal(await files.kindOf(file), 'other');
    await assert.rejects(files.entries(file));
  });

  it('spells two names of one folder the same way', async () => {
    const folder = join(DIR, 'Spelled');
    mkdirSync(folder);
    assert.equal(await files.canonical(join(DIR, '.', 'Spelled')), await files.canonical(folder));
    assert.equal(await files.canonical(folder), folder);
  });
});
