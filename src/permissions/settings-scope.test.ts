import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { settingsScope, type SettingsFile } from './settings-scope.ts';

const CLAUDE = join('/home', 'me', '.claude');
const REPO = join('/work', 'repo');
const OTHER = join('/work', 'other');

function project(folder: string): SettingsFile[] {
  return [
    { path: join(folder, '.claude', 'settings.json'), kind: 'shared' },
    { path: join(folder, '.claude', 'settings.local.json'), kind: 'local' },
  ];
}

function worktree(folder: string, tree: string): SettingsFile[] {
  return [
    { path: join(tree, '.claude', 'settings.json'), kind: 'shared', projectFile: join(folder, '.claude', 'settings.json') },
    { path: join(tree, '.claude', 'settings.local.json'), kind: 'local', projectFile: join(folder, '.claude', 'settings.local.json') },
  ];
}

describe('settingsScope', () => {
  it("lists the user settings, then each project's files and its Claude Code worktrees' in name order, each naming the project's same file", async () => {
    const worktrees = join(REPO, '.claude', 'worktrees');
    const files = new MemoryFiles({
      [join(worktrees, 'b-tree', '.claude', 'settings.local.json')]: '{}',
      [join(worktrees, 'a-tree', 'src', 'index.ts')]: '',
    });
    const scope = await settingsScope(files, CLAUDE, [REPO, OTHER], 'linux');
    assert.deepEqual(scope, [
      { path: join(CLAUDE, 'settings.json'), kind: 'user' },
      ...project(REPO),
      ...worktree(REPO, join(worktrees, 'a-tree')),
      ...worktree(REPO, join(worktrees, 'b-tree')),
      ...project(OTHER),
    ]);
  });

  it('lists a path named twice once, as first named', async () => {
    const scope = await settingsScope(new MemoryFiles(), 'C:/Users/me/.claude', ['C:/Work/Repo', 'c:/work/repo', 'C:/Users/me'], 'win32');
    assert.deepEqual(
      scope.map((file) => file.kind),
      ['user', 'shared', 'local', 'local'],
    );
    assert.equal(scope.length, 4);
  });
});
