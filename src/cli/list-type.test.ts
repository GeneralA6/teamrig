import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

describe('runCli: list --type (T1252)', () => {
  it('lists the items of the types asked for, a task with no type as a task', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Fix the stale lock', '--description', 'what and why', '--priority', 'p2', '--type', 'bug', '--session', 'alpha']);
    await kit.run(['add', '--title', 'Add a health check', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    await kit.run(['add', '--title', 'Write the guide', '--description', 'what and why', '--priority', 'p2', '--type', 'task', '--session', 'alpha']);

    const bugs = await kit.run(['list', '--type', 'bug', '--session', 'alpha']);
    assert.equal(bugs.code, EXIT.ok, bugs.stderr.join('\n'));
    assert.deepEqual(rowIds(bugs.stdout), ['T1']);
    const tasks = await kit.run(['list', '--type', 'task', '--session', 'alpha']);
    assert.deepEqual(rowIds(tasks.stdout), ['T2', 'T3']);
  });

  it('refuses a type it does not know', async () => {
    const kit = new CliHarness();
    const refused = await kit.run(['list', '--type', 'epic', '--session', 'alpha']);
    assert.equal(refused.code, EXIT.usage);
    assert.match(refused.stderr.join('\n'), /--type "epic" is not task\|bug/);
  });
});

/** The ids of the task rows `list` printed, in their order. */
function rowIds(stdout: readonly string[]): string[] {
  return stdout.join('\n').split('\n').flatMap((line) => /^(T\d+) /.exec(line)?.[1] ?? []);
}
