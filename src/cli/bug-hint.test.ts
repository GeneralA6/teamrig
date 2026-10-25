import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const HINT = 'NOTE T1 looks like a bug ("Fix"): mark it with teamrig update T1 --type bug [--critical], or --type task';

describe('runCli: the bug hint (T916)', () => {
  it('asks to mark a bug-sounding item with no type when it is added and when it starts, once', async () => {
    const kit = new CliHarness();
    const added = await kit.run(['add', '--title', 'Fix the stale lock', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    assert.deepEqual(added.stderr, [HINT]);

    const started = await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
    assert.equal(started.code, EXIT.ok, started.stderr.join('\n'));
    assert.deepEqual(started.stderr, [HINT]);

    const again = await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
    assert.deepEqual(again.stderr, [], 'a task already in progress is not asked again');
  });

  it('stays quiet once typed, as a bug or as a task, and on an item that reads as a task', async () => {
    const kit = new CliHarness();
    const marked = await kit.run(['add', '--title', 'Fix the stale lock', '--description', 'what and why', '--priority', 'p2', '--type', 'bug', '--critical', '--session', 'alpha']);
    assert.deepEqual([marked.code, marked.stderr], [EXIT.ok, []]);
    assert.match(marked.stdout[0] ?? '', /^ADDED T1 open, p2, critical bug, owner alpha/);

    await kit.run(['add', '--title', 'Fix the docs typo', '--description', 'what and why', '--priority', 'p3', '--session', 'alpha']);
    const unmarked = await kit.run(['update', 'T2', '--type', 'task', '--session', 'alpha']);
    assert.equal(unmarked.code, EXIT.ok, unmarked.stderr.join('\n'));
    const started = await kit.run(['set', 'T2', '--status', 'in-progress', '--session', 'alpha']);
    assert.deepEqual([started.code, started.stderr], [EXIT.ok, []]);

    const work = await kit.run(['add', '--title', 'Add a health check', '--description', 'Users ask for it.', '--priority', 'p2', '--session', 'alpha']);
    assert.deepEqual([work.code, work.stderr], [EXIT.ok, []]);
  });

  it('refuses a --type value it does not know', async () => {
    const kit = new CliHarness();
    const refused = await kit.run(['add', '--title', 'Fix it', '--description', 'what and why', '--priority', 'p2', '--type', 'problem', '--session', 'alpha']);
    assert.notEqual(refused.code, EXIT.ok);
    assert.match([...refused.stdout, ...refused.stderr].join('\n'), /--type "problem" is not task\|bug/);
  });

  it('refuses the old --problem flag with its new name', async () => {
    const kit = new CliHarness();
    const refused = await kit.run(['add', '--title', 'Fix it', '--description', 'what and why', '--priority', 'p2', '--problem', 'critical', '--session', 'alpha']);
    assert.equal(refused.code, EXIT.usage);
    assert.match([...refused.stdout, ...refused.stderr].join('\n'), /--problem was renamed: use --type bug \[--critical\] \(or --type task\)/);
  });
});
