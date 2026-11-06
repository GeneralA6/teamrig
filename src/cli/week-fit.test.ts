import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { APP, CliHarness, TEAM } from '../testing/cli-harness.ts';
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
    ['Record the demo', 'p2', '30'],
    ['Tidy the docs', 'p2', '35'],
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
      /to do\. From the task register at [^\n]+\n\n- fits: p2 55% \(left 69\.5% of the week\)\n- does not fit: T4 p2 alpha 35% \| Tidy the docs, \+1 after it\n- 1 to do without a size\n/,
    );
  });

  it('check flags OVER-LIMIT on the first task past the line', async () => {
    const kit = new CliHarness();
    await plannedWeek(kit);
    await kit.run(['statusline'], { stdin: status() });
    const checked = await kit.run(['check', '--all', '--session', 'alpha']);
    assert.ok(
      checked.stdout.includes(
        'OVER-LIMIT (size 35%, 14.5% of the week left after the tasks before it (left 69.5%), +1 after it) T4 open, Improvements, score 0.03, p2, owner alpha, week 01-07, from alpha | Tidy the docs',
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

describe("show a task's size", () => {
  async function sizedTask(kit: CliHarness): Promise<string[]> {
    const added = await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--size', '1.5', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stdout.join('\n'));
    const shown = await kit.run(['show', 'T1']);
    assert.equal(shown.code, EXIT.ok, shown.stderr.join('\n'));
    return shown.stdout.join('\n').split('\n');
  }

  it('in W too, at the week W per percent of budget.weeklyLimitW', async () => {
    const lines = await sizedTask(new CliHarness({ ...TEAM, budget: { weeklyLimitW: 650_000_000 } }));
    assert.ok(lines.includes('size: 1.5% of the weekly limit, about 9.75M W'), lines.join('\n'));
  });

  it('in percent alone while the W per percent is unknown', async () => {
    const lines = await sizedTask(new CliHarness());
    assert.ok(lines.includes('size: 1.5% of the weekly limit'), lines.join('\n'));
  });
});
