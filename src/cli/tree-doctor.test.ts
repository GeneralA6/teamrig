import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { TEAM_RULES_MAX_CHARS } from '../rules/pack.ts';
import { teamConfigOf, teamHomeOf, treeHarness } from '../testing/team-tree.ts';

describe('teamrig doctor in a tree of teams', () => {
  it("flags its own tree's problems and a session name another team uses, not another tree's", async () => {
    const kit = await treeHarness();
    await kit.holdSecretDeny();
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

  it("flags a child team's rules.md that the rules of the teams above leave no room for", async () => {
    const kit = await treeHarness();
    await kit.files.write(join(teamHomeOf('app'), 'rules.md'), 'a'.repeat(2_000));
    await kit.files.write(join(teamHomeOf('ui'), 'rules.md'), 'u'.repeat(1_000));
    const result = await kit.run(['doctor'], { env: { TEAMRIG_TEAM: 'ui' } });
    assert.deepEqual(
      result.stdout.filter((line) => line.startsWith('WARN rules-long')),
      [
        `WARN rules-long ${join(teamHomeOf('ui'), 'rules.md')} is 1000 characters, but the team rules shown before it (${join(teamHomeOf('app'), 'rules.md')}) take 2000 of the ${TEAM_RULES_MAX_CHARS} a session is shown at start, so sessions get only a pointer to it: shorten one of them`,
      ],
    );
    assert.ok(!(await kit.run(['doctor'])).stdout.some((line) => line.startsWith('WARN rules-long')));
  });
});
