import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { teamConfigOf, teamHomeOf, treeHarness } from '../testing/team-tree.ts';
import { loadTree } from './tree.ts';

describe('loadTree', () => {
  it('keeps each team folder whose config did not load, with how it read, apart from the tree', async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('torn'), '{ not json');
    await kit.files.write(join(teamHomeOf('bare'), 'state', 'notes.md'), 'a folder with no config');
    const loaded = await loadTree(kit.runtime());
    assert.deepEqual([...loaded.teams.keys()], ['app', 'ops', 'ui', 'web']);
    assert.deepEqual([...loaded.leftOut.keys()], ['bare', 'torn']);
    assert.deepEqual(loaded.leftOut.get('bare'), { status: 'missing', path: teamConfigOf('bare') });
    const torn = loaded.leftOut.get('torn');
    assert.equal(torn?.status, 'unreadable');
    assert.equal(torn?.path, teamConfigOf('torn'));
    assert.equal(loaded.tree.node('torn'), undefined);
  });

  it('leaves nothing out when every folder holds a config that loads', async () => {
    const kit = await treeHarness();
    assert.equal((await loadTree(kit.runtime())).leftOut.size, 0);
  });
});
