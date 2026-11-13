import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const ADD = ['add', '--title', 'Design the login slice', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha'];
const GOAL = ['goal', 'add', 'A1', '--title', 'Ship the beta', '--target', '2030-02-01', '--session', 'lead'];

describe('runCli: update --prepares, the goal slice a design prepares (T2453)', () => {
  it('lets the lead mark the slice a task prepares, which list and show print, and none clears it', async () => {
    const kit = new CliHarness();
    await kit.run(GOAL);
    await kit.run(ADD);
    const marked = await kit.run(['update', 'T1', '--prepares', 'A1:2', '--session', 'lead']);
    assert.equal(marked.code, EXIT.ok, marked.stdout.join('\n'));
    const listed = (await kit.run(['list', '--all', '--session', 'alpha'])).stdout.join('\n');
    assert.match(listed, /^T1 .*, prepares A1:2 \| Design the login slice/m);

    const cleared = await kit.run(['update', 'T1', '--prepares', 'none', '--session', 'lead']);
    assert.equal(cleared.code, EXIT.ok, cleared.stdout.join('\n'));
    const shown = (await kit.run(['show', 'T1', '--session', 'alpha'])).stdout.join('\n');
    assert.doesNotMatch(shown.split('\n')[0] ?? '', /prepares/);
    assert.match(shown, /lead update prepares=A1:2/);
    assert.match(shown, /lead update prepares=none/);
  });

  it("refuses the task's owner, a peer and a goal that is no record, writing nothing", async () => {
    const kit = new CliHarness();
    await kit.run(GOAL);
    await kit.run(ADD);
    const byOwner = await kit.run(['update', 'T1', '--prepares', 'A1:2', '--session', 'alpha']);
    assert.equal(byOwner.code, EXIT.refused);
    assert.match(byOwner.stdout.join('\n'), /^REFUSED .*marks what T1 prepares/m);
    const byPeer = await kit.run(['update', 'T1', '--prepares', 'A1:2', '--session', 'bravo']);
    assert.equal(byPeer.code, EXIT.refused);
    const unknown = await kit.run(['update', 'T1', '--prepares', 'Z9:1', '--session', 'lead']);
    assert.equal(unknown.code, EXIT.refused);
    assert.match(unknown.stdout.join('\n'), /goal Z9 is not a goal record/);
    const shown = (await kit.run(['show', 'T1', '--session', 'alpha'])).stdout.join('\n');
    assert.doesNotMatch(shown, /prepares/);
  });

  it('refuses a marker that is not <goal>:<slice> as a usage error, and add takes no --prepares', async () => {
    const kit = new CliHarness();
    await kit.run(GOAL);
    await kit.run(ADD);
    for (const bad of ['A1', 'A1:0', 'A1:x', ':2', 'A1:1.5']) {
      const result = await kit.run(['update', 'T1', '--prepares', bad, '--session', 'lead']);
      assert.equal(result.code, EXIT.usage, bad);
      assert.match(result.stderr.join('\n'), /--prepares ".*" is not <goal>:<slice>/, bad);
    }
    const onAdd = await kit.run([...ADD, '--prepares', 'A1:2']);
    assert.equal(onAdd.code, EXIT.usage);
  });
});
