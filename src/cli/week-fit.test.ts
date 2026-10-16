import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { APP, CliHarness } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const WEEK = '2030-01-07';

/** Claude Code's status input with the week 30% used, so `plan` and `check` read 69.5% left of the 99.5% target. */
function status(): string {
  return JSON.stringify({
    session_id: '0123abcd-0000-4000-8000-0000000000aa',
    cwd: APP,
    workspace: { current_dir: APP },
    rate_limits: { seven_day: { used_percentage: 30, resets_at: Date.parse('2030-01-14T01:00:00Z') / 1000 } },
  });
}

async function plannedWeek(kit: CliHarness): Promise<void> {
  const tasks: [string, string, string | undefined][] = [
    ['Ship the CLI', 'p1', '40'],
    ['Write the guide', 'p2', '25'],
    ['Record the demo', 'p2', '10'],
    ['Tidy the docs', 'p2', '2'],
    ['Answer the issues', 'p2', undefined],
  ];
  for (const [title, priority, size] of tasks) {
    const sized = size === undefined ? [] : ['--size', size];
    const added = await kit.run(['add', '--title', title, '--description', 'what and why', '--priority', priority, '--week', WEEK, ...sized, '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stdout.join('\n'));
  }
}

describe('the week fit to the weekly limit', () => {
  it('plan prints what fits, the first task past the line and the unsized count', async () => {
    const kit = new CliHarness();
    await plannedWeek(kit);
    assert.equal((await kit.run(['statusline'], { stdin: status() })).code, EXIT.ok);
    const planned = await kit.run(['plan', '--session', 'alpha']);
    assert.equal(planned.code, EXIT.ok);
    const text = planned.stdout.join('\n');
    assert.match(
      text,
      /to do\. From the task register at [^\n]+\n\n- fits: p1 40% · p2 25% \(left 69\.5% of the week\)\n- does not fit: T3 p2 alpha 10% \| Record the demo, \+1 after it\n- 1 to do without a size\n/,
    );
  });

  it('check flags OVER-LIMIT on the first task past the line', async () => {
    const kit = new CliHarness();
    await plannedWeek(kit);
    await kit.run(['statusline'], { stdin: status() });
    const checked = await kit.run(['check', '--all', '--session', 'alpha']);
    assert.ok(
      checked.stdout.includes(
        'OVER-LIMIT (size 10%, 4.5% of the week left after the tasks before it (left 69.5%), +1 after it) T3 open, p2, owner alpha, week 01-07, from alpha | Record the demo',
      ),
      checked.stdout.join('\n'),
    );
  });

  it('says the fit is unknown with no status-line reading, and raises no flag', async () => {
    const kit = new CliHarness();
    await plannedWeek(kit);
    const planned = await kit.run(['plan', '--session', 'alpha']);
    assert.ok(planned.stdout.join('\n').includes('- fits: unknown (no status-line reading of the week yet)\n- 1 to do without a size'));
    const checked = await kit.run(['check', '--all', '--session', 'alpha']);
    assert.doesNotMatch(checked.stdout.join('\n'), /OVER-LIMIT/);
  });

  it('fits only the week in force, as the limit read is this week\'s', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Plan ahead', '--description', 'what and why', '--priority', 'p1', '--week', '2030-01-14', '--size', '90', '--session', 'alpha']);
    await plannedWeek(kit);
    await kit.run(['statusline'], { stdin: status() });
    const ahead = await kit.run(['plan', '--week', '2030-01-14', '--session', 'alpha']);
    assert.equal(ahead.code, EXIT.ok);
    assert.doesNotMatch(ahead.stdout.join('\n'), /fits:|does not fit/);
  });
});
