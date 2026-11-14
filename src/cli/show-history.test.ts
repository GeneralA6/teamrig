import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

describe('runCli: show keeps the last 3 history events, --history prints all (T2535)', () => {
  it('drops the older events by default, keeps the inbox lines, and prints every event with --history', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Build the signup endpoint', '--description', 'what and why', '--priority', 'p2', '--owner', 'alpha', '--session', 'lead']);
    for (const note of ['first', 'second', 'third', 'fourth']) {
      const noted = await kit.run(['update', 'T1', '--note', note, '--session', 'lead']);
      assert.equal(noted.code, EXIT.ok, noted.stderr.join('\n'));
    }

    const shown = await kit.run(['show', 'T1', '--session', 'alpha']);
    assert.equal(shown.code, EXIT.ok, shown.stderr.join('\n'));
    const text = shown.stdout.join('\n');
    assert.match(text, /history \(last 3 of 5; --history prints all\):\n.*note="second"\n.*note="third"\n.*note="fourth"\ninbox lines naming T1 \(1\):/);
    assert.doesNotMatch(text, /create owner=alpha|note="first"/);

    const all = await kit.run(['show', 'T1', '--history', '--session', 'alpha']);
    assert.equal(all.code, EXIT.ok, all.stderr.join('\n'));
    assert.match(all.stdout.join('\n'), /history:\n.*create owner=alpha.*\n.*note="first"\n(?:.*\n){3}inbox lines naming T1 \(1\):/);
  });
});
