import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const WEB = { TEAMRIG_TEAM: 'web' };
const UI = { TEAMRIG_TEAM: 'ui' };

describe("runCli: a child team's owner decisions go up to the lead at its tree's root (T509)", () => {
  it("refuses a child team's lead the owner's daily meeting, naming the root's lead, and lets the root's lead hold it", async () => {
    const kit = await treeHarness();
    for (const [env, team] of [
      [WEB, 'web'],
      [UI, 'ui'],
    ] as const) {
      for (const command of ['start', 'agenda', 'end']) {
        const refused = await kit.run(['meeting', command, '--session', 'lead'], { env });
        assert.deepEqual(
          [refused.code, refused.stdout],
          [EXIT.refused, [`REFUSED team ${team} meets no owner: the owner's daily meeting is app/lead's, whose agenda lists ${team}'s waits on the owner`]],
        );
      }
    }
    const member = await kit.run(['meeting', 'start', '--session', 'front'], { env: WEB });
    assert.deepEqual(member.stdout, ["REFUSED only the lead (web-lead) runs the owner's daily meeting"]);
    const root = await kit.run(['meeting', 'start', '--session', 'lead']);
    assert.equal(root.code, EXIT.ok, root.stderr.join('\n'));
  });
});
