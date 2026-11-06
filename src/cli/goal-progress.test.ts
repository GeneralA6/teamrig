import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { APP, CliHarness, TEAM } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const DAY_MS = 86_400_000;
const FLAG = 'NO-PROGRESS (no goal or week-plan task moved since 01-08 00:00 UTC (1 day); the first to move) T1 open, Improvements, score 3.33, p2, owner alpha, week 01-07, from alpha | Ship the CLI';

/** Claude Code's status input with the week `usedPct` used. */
function status(usedPct: number): string {
  return JSON.stringify({
    session_id: '0123abcd-0000-4000-8000-0000000000aa',
    cwd: APP,
    workspace: { current_dir: APP },
    rate_limits: { seven_day: { used_percentage: usedPct, resets_at: Date.parse('2030-01-14T01:00:00Z') / 1000 } },
  });
}

/** The week's plan on its first working day (2030-01-08 10:00): one task alpha has not moved. */
async function plannedKit(kit = new CliHarness()): Promise<CliHarness> {
  const added = await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p2', '--week', '2030-01-07', '--session', 'alpha']);
  assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
  return kit;
}

async function checked(kit: CliHarness): Promise<string> {
  const result = await kit.run(['check', '--all', '--session', 'lead']);
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  return result.stdout.join('\n');
}

describe('check flags a day that ended with no goal progress', () => {
  it('raises NO-PROGRESS the day after a plan nothing moved, and clears once its owner starts a task', async () => {
    const kit = await plannedKit();
    assert.doesNotMatch(await checked(kit), /NO-PROGRESS/, 'the day of the plan has not ended');
    kit.clock.advance(DAY_MS);
    const flagged = await checked(kit);
    assert.ok(flagged.includes(FLAG), flagged);
    assert.equal((await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha'])).code, EXIT.ok);
    assert.doesNotMatch(await checked(kit), /NO-PROGRESS/);
  });

  it('shows the flag at the start of the owner of the task it names', async () => {
    const kit = await plannedKit();
    kit.clock.advance(DAY_MS);
    const started = await kit.run(['start', '--all', '--session', 'alpha']);
    assert.ok(started.stdout.includes(FLAG), started.stdout.join('\n'));
  });

  it("measures the team's day from its day start", async () => {
    const kit = await plannedKit(new CliHarness({ ...TEAM, wake: { dayStartUtc: '06:00' } }));
    kit.clock.advance(DAY_MS);
    assert.match(await checked(kit), /NO-PROGRESS \(no goal or week-plan task moved since 01-08 06:00 UTC \(1 day\)/);
  });

  it('raises nothing once the week is spent, or with the flag off', async () => {
    const spent = await plannedKit();
    spent.clock.advance(DAY_MS);
    assert.equal((await spent.run(['statusline'], { stdin: status(100) })).code, EXIT.ok);
    assert.doesNotMatch(await checked(spent), /NO-PROGRESS/);
    const off = await plannedKit(new CliHarness({ ...TEAM, register: { check: { goalProgressDays: 0 } } }));
    off.clock.advance(DAY_MS);
    assert.doesNotMatch(await checked(off), /NO-PROGRESS/);
  });

  it('raises it while the week has usage left', async () => {
    const kit = await plannedKit();
    kit.clock.advance(DAY_MS);
    await kit.run(['statusline'], { stdin: status(30) });
    assert.ok((await checked(kit)).includes(FLAG));
  });
});
