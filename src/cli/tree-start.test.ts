import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness, contextOf } from '../testing/cli-harness.ts';
import { treeHarness } from '../testing/team-tree.ts';

describe('the team tree at SessionStart and in teamrig rules', () => {
  const START = JSON.stringify({ session_id: 'claude-1', cwd: '/nowhere', source: 'startup' });

  it("sends a sub-team's lead to its parent lead, and keeps a member inside its team", async () => {
    const kit = await treeHarness();
    const lead = contextOf(await kit.run(['hook', 'session-start'], { env: { TEAMRIG_TEAM: 'web', TEAMRIG_SESSION: 'lead' }, stdin: START }));
    assert.match(lead, /Team `web` is a sub-team of `app` in the tree under `app`: .* your parent lead `app\/lead` \(name `app-lead`, .* Your sub-teams \(ui\) answer to you: /);
    const member = (await kit.run(['rules'], { env: { TEAMRIG_SESSION: 'alpha' } })).stdout.join('\n');
    assert.match(member, /Team `app` is part of the tree of teams under `app`: take anything outside your team to your lead/);
  });

  it('says nothing of a tree to a team on its own', async () => {
    const text = (await new CliHarness().run(['rules', '--session', 'lead'])).stdout.join('\n');
    assert.doesNotMatch(text, /tree of teams/);
  });
});
