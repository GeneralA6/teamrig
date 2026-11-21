import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../../core/guards.ts';
import { INTERFACE_VERSION } from '../../interface/index.ts';
import { CliHarness, TEAM_HOME, type RunOptions } from '../../testing/cli-harness.ts';
import { problemsOf, rowsOf, served } from '../../testing/read-answers.ts';
import { teamHomeOf, treeHarness } from '../../testing/team-tree.ts';
import { EXIT } from '../runtime.ts';

const READ_GOALS = ['read', 'goals', '--json'] as const;
const AS_WEB: RunOptions = { env: { TEAMRIG_TEAM: 'web' } };
const AS_UI: RunOptions = { env: { TEAMRIG_TEAM: 'ui' } };
const AS_OPS: RunOptions = { env: { TEAMRIG_TEAM: 'ops' } };

async function ok(kit: CliHarness, argv: readonly string[], options: RunOptions = {}): Promise<void> {
  const result = await kit.run(argv, options);
  assert.equal(result.code, EXIT.ok, [...argv, ...result.stdout, ...result.stderr].join(' '));
}

/** Adds a goal as the team's lead, its target 2030-02-01. */
async function addGoal(kit: CliHarness, tag: string, title: string, options: RunOptions = {}, more: readonly string[] = []): Promise<void> {
  await ok(kit, ['goal', 'add', tag, '--title', title, '--target', '2030-02-01', '--session', 'lead', ...more], options);
}

function goalsFileOf(team: string): string {
  return join(teamHomeOf(team), 'state', 'goals.jsonl');
}

/** Each served goal as its tag, its team and its title, in the served order. */
function heldOf(answer: JsonRecord): unknown[][] {
  return rowsOf(answer, 'goals').map((goal) => [goal['tag'], goal['team'], goal['title']]);
}

async function revisionOf(kit: CliHarness, options: RunOptions = {}, more: readonly string[] = []): Promise<string> {
  return String(served(await kit.run([...READ_GOALS, ...more], options))['revision']);
}

/** App holds A1 and S1, web its own W1 and its own S1, ui U1 and ops O1. */
async function goalsDownTheTree(): Promise<CliHarness> {
  const kit = await treeHarness();
  await addGoal(kit, 'A1', 'A signed build');
  await addGoal(kit, 'S1', 'Shared, as the root reads it');
  await addGoal(kit, 'W1', 'A faster site', AS_WEB);
  await kit.files.append(goalsFileOf('web'), `${JSON.stringify({ type: 'goal-add', v: 1, at: '2030-01-08T09:00:00.000Z', by: 'lead', tag: 'S1', title: 'Shared, as web reads it', start: '2030-01-08', target: '2030-03-01', parent: null })}\n`);
  await addGoal(kit, 'U1', 'A new palette', AS_UI);
  await addGoal(kit, 'O1', 'Quiet nights', AS_OPS);
  return kit;
}

describe('teamrig read goals', () => {
  it('answers one JSON line with the envelope and each goal of the team', async () => {
    const kit = new CliHarness();
    await addGoal(kit, 'A1', 'A signed build');
    const answer = served(await kit.run(READ_GOALS));
    assert.deepEqual([answer['interface'], answer['document'], answer['problems'], answer['cuts']], [INTERFACE_VERSION, 'goals', [], []]);
    assert.match(String(answer['revision']), /^[0-9a-f]{16}$/);
    assert.deepEqual(answer['goals'], [{ tag: 'A1', team: 'app', title: 'A signed build', parent: null, rank: null, slice: null, start: '2030-01-08', target: '2030-02-01', slips: [] }]);
  });

  it('serves a goal’s parent, rank and the moves of its target, the ranked goals first', async () => {
    const kit = new CliHarness();
    await addGoal(kit, 'A1', 'A signed build');
    await addGoal(kit, 'A1.1', 'The key is rotated', {}, ['--parent', 'A1', '--start', '2030-01-10']);
    await ok(kit, ['goal', 'rank', 'A1.1', '1', '--session', 'lead']);
    await ok(kit, ['goal', 'set', 'A1.1', '--target', '2030-01-25', '--note', 'the audit moved up', '--session', 'lead']);
    const [first, second] = rowsOf(served(await kit.run(READ_GOALS)), 'goals');
    assert.deepEqual([second?.['tag'], second?.['rank']], ['A1', null]);
    assert.deepEqual(
      [first?.['tag'], first?.['parent'], first?.['rank'], first?.['start'], first?.['target']],
      ['A1.1', 'A1', 1, '2030-01-10', '2030-01-25'],
    );
    assert.deepEqual(first?.['slips'], [{ at: new Date(kit.clock.now()).toISOString(), by: 'lead', from: '2030-02-01', to: '2030-01-25', note: 'the audit moved up' }]);
  });

  it('serves a team its own goals and those of the teams above it, never a team’s beside or below it', async () => {
    const kit = await goalsDownTheTree();
    assert.deepEqual(heldOf(served(await kit.run(READ_GOALS, AS_UI))), [
      ['A1', 'app', 'A signed build'],
      ['S1', 'web', 'Shared, as web reads it'],
      ['U1', 'ui', 'A new palette'],
      ['W1', 'web', 'A faster site'],
    ]);
    assert.deepEqual(heldOf(served(await kit.run(READ_GOALS))), [
      ['A1', 'app', 'A signed build'],
      ['S1', 'app', 'Shared, as the root reads it'],
    ]);
    assert.deepEqual(heldOf(served(await kit.run(READ_GOALS, AS_OPS))).map(([tag]) => tag), ['A1', 'O1', 'S1']);
  });

  it('serves the goals of a team above the caller’s with --team', async () => {
    const kit = await goalsDownTheTree();
    const answer = served(await kit.run([...READ_GOALS, '--team', 'web'], AS_UI));
    assert.deepEqual(heldOf(answer).map(([tag]) => tag), ['A1', 'S1', 'W1']);
  });

  it('says which goals file had lines left out, by its team’s folder, and serves the rest', async () => {
    const kit = await goalsDownTheTree();
    await kit.files.append(goalsFileOf('app'), '{ torn\n');
    await kit.files.append(goalsFileOf('web'), `${JSON.stringify({ type: 'goal-rank', v: 1, at: '2030-01-08T09:00:00.000Z', by: 'lead', tag: 'GONE', rank: 1 })}\n`);
    const answer = served(await kit.run(READ_GOALS, AS_WEB));
    assert.deepEqual(problemsOf(answer), ['app/state/goals.jsonl: 1 unreadable line(s) left out', 'web/state/goals.jsonl: 1 record(s) of no goal left out']);
    assert.deepEqual(heldOf(answer).map(([tag]) => tag), ['A1', 'S1', 'W1']);
  });

  it('leaves out a record whose time is not teamrig’s stamp, so words stored in it are never served', async () => {
    const kit = new CliHarness();
    await addGoal(kit, 'A1', 'Ship the gate');
    const words = ['pass', 'word', '=', 'hunter2'].join('');
    const moved = { type: 'goal-set', v: 1, at: `Jan 9 2030 08:00 UTC (${words})`, by: 'lead', tag: 'A1', note: 'moved', target: '2030-02-10' };
    await kit.files.append(join(TEAM_HOME, 'state', 'goals.jsonl'), `${JSON.stringify(moved)}\n`);
    const run = await kit.run(READ_GOALS);
    const answer = served(run);
    assert.deepEqual(rowsOf(answer, 'goals').map((goal) => [goal['tag'], goal['target'], goal['slips']]), [['A1', '2030-02-01', []]]);
    assert.deepEqual(problemsOf(answer), ['app/state/goals.jsonl: 1 unreadable line(s) left out']);
    assert.ok(!run.stdout.join('').includes(words));
  });

  it('serves no goal, and no problem, to a team that has none', async () => {
    const answer = served(await new CliHarness().run(READ_GOALS));
    assert.deepEqual([answer['goals'], answer['problems']], [[], []]);
  });

  it('answers unchanged to a reader holding the revision, whichever session it names', async () => {
    const kit = new CliHarness();
    await addGoal(kit, 'A1', 'A signed build');
    const held = await revisionOf(kit);
    assert.equal(await revisionOf(kit, {}, ['--owner', 'alpha']), held);
    assert.deepEqual(served(await kit.run([...READ_GOALS, '--unless', `goals=${held}`])), { interface: INTERFACE_VERSION, document: 'goals', revision: held, unchanged: true });
  });

  it('moves the revision with a goal of the team or of a team above, and with no other team’s', async () => {
    const kit = await goalsDownTheTree();
    const first = await revisionOf(kit, AS_WEB);
    await addGoal(kit, 'O2', 'Fewer pages', AS_OPS);
    await addGoal(kit, 'U2', 'A dark theme', AS_UI);
    assert.equal(await revisionOf(kit, AS_WEB), first);
    await addGoal(kit, 'A2', 'A second root goal');
    const second = await revisionOf(kit, AS_WEB);
    assert.notEqual(second, first);
    await ok(kit, ['goal', 'rank', 'W1', '1', '--session', 'lead'], AS_WEB);
    assert.notEqual(await revisionOf(kit, AS_WEB), second);
  });

  it('reads the single team’s file where the kit home holds no other', async () => {
    const kit = new CliHarness();
    await addGoal(kit, 'A1', 'A signed build');
    await kit.files.append(join(TEAM_HOME, 'state', 'goals.jsonl'), '{ torn\n');
    assert.deepEqual(problemsOf(served(await kit.run(READ_GOALS))), ['app/state/goals.jsonl: 1 unreadable line(s) left out']);
  });
});
