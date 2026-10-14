import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatConfig } from '../config/load.ts';
import { teamConfigOf, treeHarness } from '../testing/team-tree.ts';

describe('teamrig doctor in a tree of teams', () => {
  it("flags its own tree's problems and a session name another team uses, not another tree's", async () => {
    const kit = await treeHarness();
    const config = (team: string, parent: string, names: Record<string, string> = {}) =>
      formatConfig({ configVersion: 1, team: { id: team, parent }, sessions: ['lead', 'x'], roles: { lead: 'lead' }, names });
    await kit.files.write(teamConfigOf('deep'), config('deep', 'ui', { x: 'app-alpha' }));
    await kit.files.write(teamConfigOf('blog'), config('blog', 'gone'));
    const result = await kit.run(['doctor']);
    assert.deepEqual(result.stdout, [
      'DOCTOR 2 finding(s), team app',
      'WARN tree-depth team deep is at level 4 of its tree, and a tree has at most 3 levels: hang it under a team nearer the root',
      'WARN name-two-teams app-alpha is the session name of app/alpha, deep/x: Claude Code session names are machine-wide, so messages by that name can reach the wrong team; give one a new name with `teamrig rename`',
    ]);
    assert.deepEqual((await kit.run(['doctor'], { env: { TEAMRIG_TEAM: 'blog' } })).stdout.slice(0, 2), [
      'DOCTOR 1 finding(s), team blog',
      'WARN tree-parent team blog names parent gone, which has no team config: create it with `teamrig team create gone`, or fix team.parent',
    ]);
  });
});
