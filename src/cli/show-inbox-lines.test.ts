import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

describe('runCli: show lists the inbox lines that name the task (T1196)', () => {
  it('prints a correction sent by line under the history, once with each receiver, and only for the task it names', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Remove the market module', '--description', 'what and why', '--priority', 'p2', '--owner', 'alpha', '--session', 'lead']);
    await kit.run(['add', '--title', 'Another task', '--description', 'what and why', '--priority', 'p2', '--owner', 'alpha', '--session', 'lead']);
    const sent = await kit.run(['inbox', 'add', '--to', 'alpha,bravo', '--text', 'T1 correction: keep the candles route', '--session', 'lead']);
    assert.equal(sent.code, EXIT.ok, sent.stdout.join('\n'));

    const shown = await kit.run(['show', 'T1', '--session', 'alpha']);
    assert.equal(shown.code, EXIT.ok, shown.stderr.join('\n'));
    const text = shown.stdout.join('\n');
    assert.match(
      text,
      /history:\n(?: {2}.*\n)+inbox lines naming T1 \(2\):\n {2}- 2030-01-08 10:00 UTC lead: T1 is yours \(p2\): Remove the market module \(to alpha\)\n {2}- 2030-01-08 10:00 UTC lead: T1 correction: keep the candles route \(to alpha, bravo\)$/,
    );

    const other = await kit.run(['show', 'T2', '--session', 'alpha']);
    assert.doesNotMatch(other.stdout.join('\n'), /correction/);
  });
});
