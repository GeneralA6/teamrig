import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_MINUTE } from '../core/time.ts';
import { APP, CLAUDE_SESSION, CliHarness, contextOf, TEAM } from '../testing/cli-harness.ts';
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

/**
 * The harness where two Roadmap tasks ask the lead's approval: T1, due first so it leads the plan order, asks 30 minutes
 * after T2, so T2 alone passes the limit 31 minutes later.
 */
async function twoAsking(): Promise<CliHarness> {
  const kit = new CliHarness();
  const step = async (...args: string[]): Promise<void> => {
    const result = await kit.run(args);
    assert.equal(result.code, EXIT.ok, [...args, ...result.stdout, ...result.stderr].join(' '));
  };
  await step(...ADD, '--class', 'Roadmap', '--due', '2030-01-10', '--session', 'alpha');
  await step('add', '--title', 'Ship the table', '--description', 'what and why', '--priority', 'p2', '--class', 'Roadmap', '--session', 'bravo');
  await step('set', 'T2', '--status', 'in-progress', '--session', 'bravo');
  await step('set', 'T2', '--status', 'waiting', '--waits', 'approval:lead', '--note', 'branch t2, the table', '--session', 'bravo');
  kit.clock.advance(30 * MS_PER_MINUTE);
  await step('set', 'T1', '--status', 'in-progress', '--session', 'alpha');
  await step(...ASK, '--session', 'alpha');
  return kit;
}

/** The task ids of the WAITING ON YOU rows in `lines`, in the order they print. */
function waitingIds(lines: readonly string[]): string[] {
  const from = lines.findIndex((line) => line.startsWith('WAITING ON YOU'));
  assert.notEqual(from, -1, lines.join('\n'));
  return lines.slice(from + 1).flatMap((line) => /^ {2}(T\d+) /.exec(line)?.[1] ?? []);
}

/** The ids `start` lists as waiting on the lead. */
async function startOrder(kit: CliHarness): Promise<string[]> {
  const started = await kit.run(['start', '--all', '--session', 'lead']);
  assert.equal(started.code, EXIT.ok, started.stderr.join('\n'));
  return waitingIds(started.stdout);
}

/** The ids the live block of the lead's start note lists as waiting on it. */
async function noteOrder(kit: CliHarness): Promise<string[]> {
  const stdin = JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, source: 'compact' });
  const note = contextOf(await kit.run(['hook', 'session-start'], { env: { TEAMRIG_SESSION: 'lead' }, stdin }));
  return waitingIds(note.split('\n'));
}

describe('runCli: what waits on a leader, held work first', () => {
  it("lists the task held on the leader first in its start, above one that leads the plan order", async () => {
    const kit = await twoAsking();
    assert.deepEqual(await startOrder(kit), ['T1', 'T2'], 'inside the limit, the plan order');
    kit.clock.advance(31 * MS_PER_MINUTE);
    assert.deepEqual(await startOrder(kit), ['T2', 'T1']);
  });

  it("lists it first in the live block of the leader's start note too", async () => {
    const kit = await twoAsking();
    assert.deepEqual(await noteOrder(kit), ['T1', 'T2'], 'inside the limit, the plan order');
    kit.clock.advance(31 * MS_PER_MINUTE);
    assert.deepEqual(await noteOrder(kit), ['T2', 'T1']);
  });
});

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
