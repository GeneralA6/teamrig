import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const ADD = ['add', '--title', 'Add a health check', '--description', 'what and why', '--priority', 'p2'];

describe('runCli: a task work class, --class on add and update (T2076)', () => {
  it('adds a task with a class of focus.classes, which show prints, and refuses any other', async () => {
    const kit = new CliHarness();
    const added = await kit.run([...ADD, '--class', 'Roadmap', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    const shown = await kit.run(['show', 'T1', '--session', 'alpha']);
    assert.match(shown.stdout.join('\n'), /^T1 open, Roadmap, score 10, p2, .* \| Add a health check/m);
    assert.match(shown.stdout.join('\n'), / workClass=Roadmap/);

    const refused = await kit.run(['add', '--title', 'Write the guide', '--description', 'what and why', '--priority', 'p2', '--class', 'Chores', '--session', 'alpha']);
    assert.equal(refused.code, EXIT.refused);
    assert.match(refused.stdout.join('\n'), /^REFUSED .*class Chores is not one of focus\.classes \(Roadmap, Maintenance, Improvements\)/m);
  });

  it("lets the owner or the lead change a task's class, none clearing it, and refuses a peer", async () => {
    const kit = new CliHarness();
    await kit.run([...ADD, '--session', 'alpha']);
    const byLead = await kit.run(['update', 'T1', '--class', 'Maintenance', '--session', 'lead']);
    assert.equal(byLead.code, EXIT.ok, byLead.stdout.join('\n'));
    const byPeer = await kit.run(['update', 'T1', '--class', 'Roadmap', '--session', 'bravo']);
    assert.equal(byPeer.code, EXIT.refused);
    const cleared = await kit.run(['update', 'T1', '--class', 'none', '--session', 'alpha']);
    assert.equal(cleared.code, EXIT.ok, cleared.stdout.join('\n'));
    const shown = (await kit.run(['show', 'T1', '--session', 'alpha'])).stdout.join('\n');
    assert.doesNotMatch(shown.split('\n')[0] ?? '', /class/);
    assert.match(shown, /lead update workClass=Maintenance/);
    assert.match(shown, /alpha update workClass=none/);
  });
});
