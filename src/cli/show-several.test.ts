import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

async function withTwoTasks(): Promise<CliHarness> {
  const kit = new CliHarness();
  await kit.run(['add', '--title', 'Remove the market module', '--description', 'what and why', '--priority', 'p2', '--owner', 'alpha', '--session', 'lead']);
  await kit.run(['add', '--title', 'Another task', '--description', 'what and why', '--priority', 'p2', '--owner', 'alpha', '--session', 'lead']);
  return kit;
}

/** The task lines `show` printed, in order: each task's detail starts with its id and status. */
function shownIds(stdout: readonly string[]): string[] {
  return stdout.join('\n').split('\n').flatMap((line) => /^(T\d+) (?:open|in-progress|waiting|verifying|done|dropped)\b/.exec(line)?.slice(1, 2) ?? []);
}

describe('runCli: show of several ids in one call (T2536)', () => {
  it('prints each task in full, in the order given, as one show each would', async () => {
    const kit = await withTwoTasks();
    const both = await kit.run(['show', 'T2', 'T1', '--session', 'alpha']);
    assert.equal(both.code, EXIT.ok, both.stderr.join('\n'));
    const one = await kit.run(['show', 'T2', '--session', 'alpha']);
    const other = await kit.run(['show', 'T1', '--session', 'alpha']);
    assert.deepEqual(both.stdout, [...one.stdout, ...other.stdout]);
    assert.deepEqual(shownIds(both.stdout), ['T2', 'T1']);
  });

  it('shows an id named twice once', async () => {
    const kit = await withTwoTasks();
    const shown = await kit.run(['show', 'T1', 'T1', 'T2', '--session', 'alpha']);
    assert.deepEqual(shownIds(shown.stdout), ['T1', 'T2']);
  });

  it('refuses every unknown id before it prints anything, so a partial view is never read as the whole', async () => {
    const kit = await withTwoTasks();
    const shown = await kit.run(['show', 'T1', 'T9', 'T8', '--session', 'alpha']);
    assert.equal(shown.code, EXIT.refused);
    assert.deepEqual(shown.stdout, ['REFUSED no task T9, T8'], 'the refusal is the only line: no task of the call printed');
  });

  it('still needs one id', async () => {
    const shown = await (await withTwoTasks()).run(['show', '--session', 'alpha']);
    assert.equal(shown.code, EXIT.usage);
    assert.match(shown.stderr.join('\n'), /show needs <id>/);
  });
});
