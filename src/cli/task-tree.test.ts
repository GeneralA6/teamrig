import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const WHAT = ['--description', 'what and why', '--priority', 'p2'];

/**
 * alpha's T1 and bravo's T2 (waiting on the lead's decision) come before bravo's T3, due 01-12; alpha's T4 comes
 * after T3.
 */
async function treeTeam(): Promise<CliHarness> {
  const kit = new CliHarness();
  const steps = [
    ['add', '--title', 'Write the API', ...WHAT, '--session', 'alpha'],
    ['add', '--title', 'Pick the docs host', ...WHAT, '--session', 'bravo'],
    ['set', 'T2', '--status', 'in-progress', '--session', 'bravo'],
    ['set', 'T2', '--status', 'waiting', '--waits', 'decision:lead', '--note', 'two hosts', '--session', 'bravo'],
    ['add', '--title', 'Ship the docs', ...WHAT, '--due', '2030-01-12', '--after', 'T1,T2', '--session', 'bravo'],
    ['add', '--title', 'Publish the guide', ...WHAT, '--after', 'T3', '--session', 'alpha'],
  ];
  for (const step of steps) {
    const result = await kit.run(step);
    assert.equal(result.code, EXIT.ok, [...step, ...result.stdout].join(' '));
  }
  return kit;
}

/** The lines from the one starting with `head` up to the next upper-case heading. */
function block(stdout: readonly string[], head: string): string[] {
  const from = stdout.findIndex((line) => line.startsWith(head));
  if (from === -1) {
    return [];
  }
  const to = stdout.findIndex((line, index) => index > from && /^[A-Z]+ /.test(line));
  return stdout.slice(from, to === -1 ? undefined : to);
}

describe('runCli: the dependency tree', () => {
  it('shows what a task needs and what needs it with --tree, then who moves next', async () => {
    const kit = await treeTeam();
    const shown = await kit.run(['show', 'T3', '--tree', '--session', 'bravo']);
    assert.equal(shown.code, EXIT.ok, shown.stdout.join('\n'));
    assert.match(shown.stdout[0] ?? '', /^T3 open, Improvements, score 5, p2, owner bravo, due 01-12, after T1,T2, .*\| Ship the docs · needed by T4 \(alpha\)$/);
    assert.deepEqual(shown.stdout.slice(1), [
      'needs:',
      '  T1 open, Improvements, score 5, p2, owner alpha, due 01-12 (from T3) | Write the API',
      '  T2 waiting, Improvements, score 5, p2, owner bravo, due 01-12 (from T3) | Pick the docs host (waiting: decision lead)',
      'needed by:',
      '  T4 open, Improvements, score 3.33, p2, owner alpha, after T3 | Publish the guide',
      'Next move: alpha (T1)',
    ]);

    const leaf = await kit.run(['show', 'T4', '--tree', '--session', 'alpha']);
    assert.deepEqual(leaf.stdout.slice(1), [
      'needs:',
      '  T3 open, Improvements, score 5, p2, owner bravo, due 01-12, after T1,T2 | Ship the docs',
      '    T1 open, Improvements, score 5, p2, owner alpha, due 01-12 (from T3) | Write the API',
      '    T2 waiting, Improvements, score 5, p2, owner bravo, due 01-12 (from T3) | Pick the docs host (waiting: decision lead)',
      'needed by: none',
      'Next move: alpha (T1)',
    ]);
    const detail = await kit.run(['show', 'T4', '--session', 'alpha']);
    assert.ok(!detail.stdout.some((line) => line.startsWith('needs:')), 'without --tree, show prints the task whole');
  });

  it('lists a task by its effective due, naming the other session whose task needs it', async () => {
    const kit = await treeTeam();
    const listed = await kit.run(['list', '--session', 'alpha']);
    assert.deepEqual(listed.stdout.slice(1), [
      'T1 open, Improvements, score 5, p2, owner alpha, due 01-12 (from T3) | Write the API · needed by T3 (bravo) · ahead: score 5',
      'T4 open, Improvements, score 3.33, p2, owner alpha, after T3 | Publish the guide',
    ]);
  });

  it("starts each session with the other sessions' tasks waiting on it", async () => {
    const kit = await treeTeam();
    const alpha = await kit.run(['start', '--session', 'alpha']);
    assert.equal(alpha.code, EXIT.ok, alpha.stdout.join('\n'));
    assert.deepEqual(block(alpha.stdout, 'WAITING ON YOU'), [
      'WAITING ON YOU 1 task(s) of other sessions wait on alpha',
      '  T3 open, Improvements, score 5, p2, owner bravo, due 01-12, after T1,T2 | Ship the docs · needs your T1',
    ]);
    const lead = await kit.run(['start', '--session', 'lead']);
    assert.deepEqual(block(lead.stdout, 'WAITING ON YOU'), [
      'WAITING ON YOU 1 task(s) of other sessions wait on lead',
      '  T2 waiting, Improvements, score 5, p2, owner bravo, due 01-12 (from T3) | Pick the docs host (waiting: decision lead) · waits on your decision',
    ]);
    const bravo = await kit.run(['start', '--session', 'bravo']);
    assert.match(block(bravo.stdout, 'WAITING ON YOU')[1] ?? '', /^ {2}T4 .*· needs your T3$/);
  });

  it('refuses a plan dependency that would close a loop, with the path and how to split the step out', async () => {
    const kit = await treeTeam();
    const refused = await kit.run(['update', 'T1', '--after', 'T4', '--session', 'alpha']);
    assert.equal(refused.code, EXIT.refused);
    assert.deepEqual(refused.stdout, [
      'REFUSED T1 -> T4 -> T3 -> T1 would be a loop, and no task in a loop can finish: make the step T1 needs from T4 its own task: teamrig add --owner alpha --title "<the step>", then teamrig update T1 --after <its id>',
    ]);
  });
});
