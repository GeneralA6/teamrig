import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { treeFieldsOf, treeHeader, type RunTree } from './run-tree.ts';

const CLEAN: RunTree = { kind: 'git', top: '/work/app', head: 'c0ffee12345', dirty: false };

describe('treeHeader', () => {
  it("names the folder, the repository's top level, HEAD's commit and a clean tree", () => {
    assert.equal(treeHeader('/work/app/src', CLEAN), '# folder: /work/app/src\n# git: /work/app at c0ffee12345, clean\n');
  });

  it('marks a tree with uncommitted changes, and a repository with no commit yet', () => {
    assert.equal(treeHeader('/work/app', { ...CLEAN, dirty: true }), '# folder: /work/app\n# git: /work/app at c0ffee12345, with uncommitted changes\n');
    assert.equal(treeHeader('/work/app', { ...CLEAN, head: null }), '# folder: /work/app\n# git: /work/app at no commit yet, clean\n');
  });

  it('says a run outside any git repository ran outside one', () => {
    assert.equal(treeHeader('/tmp/scratch', { kind: 'outside' }), '# folder: /tmp/scratch\n# git: none, it ran outside a git repository\n');
  });
});

describe('treeFieldsOf', () => {
  it('gives the folder, the top level, the commit and the dirty flag', () => {
    assert.deepEqual(treeFieldsOf('/work/app/src', CLEAN), { cwd: '/work/app/src', gitTop: '/work/app', head: 'c0ffee12345', dirty: false });
    assert.deepEqual(treeFieldsOf('/work/app', { ...CLEAN, head: null, dirty: true }), { cwd: '/work/app', gitTop: '/work/app', dirty: true });
  });

  it('gives only the folder outside git', () => {
    assert.deepEqual(treeFieldsOf('/tmp/scratch', { kind: 'outside' }), { cwd: '/tmp/scratch' });
  });
});
