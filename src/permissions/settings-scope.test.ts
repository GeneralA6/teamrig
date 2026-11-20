import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { testPaths } from '../testing/host.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { settingsScope, type SettingsFile, type SettingsHost } from './settings-scope.ts';

const HOME = join('/home', 'me');
const CLAUDE = join(HOME, '.claude');
const SHIPPED: SettingsHost = { paths: testPaths(), userHome: HOME };
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
    const scope = await settingsScope(files, SHIPPED, [REPO, OTHER], 'linux');
    assert.deepEqual(scope, [
      { path: join(CLAUDE, 'settings.json'), kind: 'user' },
      ...project(REPO),
      ...worktree(REPO, join(worktrees, 'a-tree')),
      ...worktree(REPO, join(worktrees, 'b-tree')),
      ...project(OTHER),
    ]);
  });

  it('lists a path named twice once, as first named', async () => {
    const scope = await settingsScope(new MemoryFiles(), { paths: testPaths(), userHome: 'C:/Users/me' }, ['C:/Work/Repo', 'c:/work/repo', 'C:/Users/me'], 'win32');
    assert.deepEqual(
      scope.map((file) => file.kind),
      ['user', 'shared', 'local', 'local'],
    );
    assert.equal(scope.length, 4);
  });

  it("joins no name of its own: a host with other files, and other worktrees, is listed by what its paths tell", async () => {
    const trees = join(REPO, '.trees');
    const other: SettingsHost = {
      paths: {
        userSettings: (userHome) => join(userHome, 'agent.toml'),
        folderSettings: (folder) => [{ path: join(folder, '.agent', 'rules.toml'), kind: 'local' }],
        worktrees: (folder) => join(folder, '.trees'),
      },
      userHome: HOME,
    };
    const files = new MemoryFiles({ [join(trees, 'fix', 'src', 'index.ts')]: '' });
    assert.deepEqual(await settingsScope(files, other, [REPO], 'linux'), [
      { path: join(HOME, 'agent.toml'), kind: 'user' },
      { path: join(REPO, '.agent', 'rules.toml'), kind: 'local' },
      { path: join(trees, 'fix', '.agent', 'rules.toml'), kind: 'local', projectFile: join(REPO, '.agent', 'rules.toml') },
    ]);
  });
});
