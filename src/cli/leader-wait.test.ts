import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_MINUTE } from '../core/time.ts';
import { CliHarness, TEAM } from '../testing/cli-harness.ts';
import { treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const FLAG = 'ROADMAP-WAITS-ON-LEAD (approval:lead unanswered for 61 min, past the 60 min limit: answer it first) T1 waiting,';
const ADD = ['add', '--title', 'Ship the chart', '--description', 'what and why', '--priority', 'p2'];
const ASK = ['set', 'T1', '--status', 'waiting', '--waits', 'approval:lead', '--note', 'branch t1, the chart'];

/** Whether `lines` hold the flag on T1: its reason and the task it falls on, as the rest of a row is the row's own spec. */
function flagged(lines: readonly string[]): boolean {
  return lines.some((line) => line.startsWith(FLAG));
}

/** The harness where alpha's T1, of class `workClass`, has asked the lead's approval at the harness's start. */
async function asking(workClass: string, kit = new CliHarness()): Promise<CliHarness> {
  await kit.run([...ADD, '--class', workClass, '--session', 'alpha']);
  await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
  const asked = await kit.run([...ASK, '--session', 'alpha']);
  assert.equal(asked.code, EXIT.ok, asked.stdout.join('\n'));
  return kit;
}

async function checkOf(kit: CliHarness): Promise<readonly string[]> {
  const checked = await kit.run(['check', '--all', '--session', 'lead']);
  assert.equal(checked.code, EXIT.ok, checked.stderr.join('\n'));
  return checked.stdout;
}

describe('runCli: ROADMAP-WAITS-ON-LEAD', () => {
  it('raises the flag on a real check once the wait has stood past the limit', async () => {
    const kit = await asking('Roadmap');
    kit.clock.advance(61 * MS_PER_MINUTE);
    const lines = await checkOf(kit);
    assert.ok(flagged(lines), lines.join('\n'));
  });

  it('raises nothing inside the limit', async () => {
    const kit = await asking('Roadmap');
    kit.clock.advance(59 * MS_PER_MINUTE);
    assert.equal(flagged(await checkOf(kit)), false);
  });

  it('raises nothing on work of another class', async () => {
    const kit = await asking('Improvements');
    kit.clock.advance(61 * MS_PER_MINUTE);
    assert.deepEqual((await checkOf(kit)).filter((line) => line.startsWith('ROADMAP-WAITS-ON-LEAD')), []);
  });

  it("clears on the leader's answer", async () => {
    const kit = await asking('Roadmap');
    kit.clock.advance(61 * MS_PER_MINUTE);
    const approved = await kit.run(['approve', 'T1', '--note', 'tests green', '--session', 'lead']);
    assert.equal(approved.code, EXIT.ok, approved.stdout.join('\n'));
    assert.deepEqual((await checkOf(kit)).filter((line) => line.startsWith('ROADMAP-WAITS-ON-LEAD')), []);
  });

  it('reads the limit from the team config', async () => {
    const kit = await asking('Roadmap', new CliHarness({ ...TEAM, focus: { leaderWaitMinutes: 120 } }));
    kit.clock.advance(61 * MS_PER_MINUTE);
    assert.equal(flagged(await checkOf(kit)), false);
  });

  it("shows the flag in the leader's own start", async () => {
    const kit = await asking('Roadmap');
    kit.clock.advance(61 * MS_PER_MINUTE);
    const started = await kit.run(['start', '--all', '--session', 'lead']);
    assert.ok(flagged(started.stdout), started.stdout.join('\n'));
  });

  it("reads a child team's tasks in check --tree against that team's own lead", async () => {
    const kit = await treeHarness();
    const web = { env: { TEAMRIG_TEAM: 'web' } };
    await kit.run([...ADD, '--class', 'Roadmap', '--session', 'front'], web);
    await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'front'], web);
    await kit.run([...ASK, '--session', 'front'], web);
    kit.clock.advance(61 * MS_PER_MINUTE);
    const checked = await kit.run(['check', '--tree', '--all', '--session', 'lead']);
    assert.equal(checked.code, EXIT.ok, checked.stderr.join('\n'));
    assert.match(checked.stdout.join('\n'), /ROADMAP-WAITS-ON-LEAD \(approval:lead unanswered for 61 min/);
  });
});
