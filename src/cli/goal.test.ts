import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readGoals, type Goal } from '../register/goals.ts';
import { CliHarness, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { goalTree } from './commands/goal.ts';
import { EXIT } from './runtime.ts';

const GOALS_PATH = join(TEAM_HOME, 'state', 'goals.jsonl');
const DAY_MS = 24 * 60 * 60 * 1000;
const ADD_A1 = ['goal', 'add', 'A1', '--title', 'Ship the beta', '--target', '2030-02-01', '--session', 'lead'];

function ok(result: CliResult): void {
  assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
}

/** What a run printed, on either stream: a refusal prints on stdout, a usage error on stderr. */
function said(result: CliResult): string {
  return [...result.stdout, ...result.stderr].join('\n');
}

async function goalsText(kit: CliHarness): Promise<string | undefined> {
  return kit.files.read(GOALS_PATH);
}

/** The harness team with goal A1 and its part A1.1 added by the lead. */
async function withGoals(): Promise<CliHarness> {
  const kit = new CliHarness();
  ok(await kit.run(ADD_A1));
  ok(await kit.run(['goal', 'add', 'A1.1', '--title', 'Login works', '--start', '2030-01-09', '--target', '2030-01-20', '--parent', 'A1', '--session', 'lead']));
  return kit;
}

describe('runCli: goal add', () => {
  it("adds a goal from today to its target, written by the lead, and lists it", async () => {
    const kit = new CliHarness();
    const added = await kit.run(ADD_A1);
    ok(added);
    assert.deepEqual(added.stdout, ['ADDED goal A1 2030-01-08 to 2030-02-01 | Ship the beta']);
    const goal = readGoals(await goalsText(kit)).goals.get('A1');
    assert.deepEqual(goal, { tag: 'A1', title: 'Ship the beta', start: '2030-01-08', target: '2030-02-01', parent: null, addedAt: '2030-01-08T10:00:00.000Z', addedBy: 'lead', slips: [] });
  });

  it('lists the goals as a tree, each part under the goal it is part of', async () => {
    const kit = await withGoals();
    ok(await kit.run(['goal', 'add', 'B1', '--title', 'Docs site', '--target', '2030-03-01', '--session', 'lead']));
    ok(await kit.run(['goal', 'add', 'A2', '--title', 'Billing', '--target', '2030-02-20', '--parent', 'A1', '--session', 'lead']));
    const listed = await kit.run(['goal', 'list']);
    ok(listed);
    assert.deepEqual(listed.stdout, [
      'GOALS 4 (teamrig goal show <tag> prints one with its slips)',
      '  A1 2030-01-08 to 2030-02-01 | Ship the beta',
      '    A1.1 2030-01-09 to 2030-01-20, part of A1 | Login works',
      '    A2 2030-01-08 to 2030-02-20, part of A1 | Billing',
      '  B1 2030-01-08 to 2030-03-01 | Docs site',
    ]);
  });

  it('refuses a session that is not the lead, writing nothing', async () => {
    const kit = new CliHarness();
    const refused = await kit.run(['goal', 'add', 'A1', '--title', 'Ship the beta', '--target', '2030-02-01', '--session', 'alpha']);
    assert.equal(refused.code, EXIT.refused);
    assert.match(said(refused), /^REFUSED only the lead \(app-lead\) adds and changes the team's goals$/);
    assert.equal(await goalsText(kit), undefined);
  });

  it('refuses a second add of a tag, a missing parent and a start after the target, writing nothing', async () => {
    const kit = await withGoals();
    const before = await goalsText(kit);
    const again = await kit.run(ADD_A1);
    assert.equal(again.code, EXIT.refused);
    assert.match(said(again), /goal A1 already exists; move its target with goal set/);
    const orphan = await kit.run(['goal', 'add', 'C1', '--title', 'Orphan', '--target', '2030-02-01', '--parent', 'C0', '--session', 'lead']);
    assert.equal(orphan.code, EXIT.refused);
    assert.match(said(orphan), /--parent C0 is not a goal; add it first/);
    const backwards = await kit.run(['goal', 'add', 'C2', '--title', 'Backwards', '--start', '2030-02-02', '--target', '2030-02-01', '--session', 'lead']);
    assert.equal(backwards.code, EXIT.refused);
    assert.match(said(backwards), /--start 2030-02-02 is after --target 2030-02-01/);
    assert.equal(await goalsText(kit), before);
  });

  it('reads a bad tag, a bad day, a missing title and an overlong title as usage errors', async () => {
    const kit = new CliHarness();
    const none = await kit.run(['goal', 'add', 'none', '--title', 'Nothing', '--target', '2030-02-01', '--session', 'lead']);
    assert.equal(none.code, EXIT.usage);
    assert.match(said(none), /"none" is not a goal tag/);
    const digit = await kit.run(['goal', 'add', '1A', '--title', 'Digit first', '--target', '2030-02-01', '--session', 'lead']);
    assert.equal(digit.code, EXIT.usage);
    const day = await kit.run(['goal', 'add', 'A1', '--title', 'Ship the beta', '--target', '2030-02-30', '--session', 'lead']);
    assert.equal(day.code, EXIT.usage);
    assert.match(said(day), /--target "2030-02-30" is not a YYYY-MM-DD day/);
    const untitled = await kit.run(['goal', 'add', 'A1', '--target', '2030-02-01', '--session', 'lead']);
    assert.equal(untitled.code, EXIT.usage);
    const long = await kit.run(['goal', 'add', 'A1', '--title', 'x'.repeat(141), '--target', '2030-02-01', '--session', 'lead']);
    assert.equal(long.code, EXIT.usage);
    assert.match(said(long), /--title holds 141 characters: at most 140/);
    assert.equal(await goalsText(kit), undefined);
  });
});

describe('runCli: goal set and show', () => {
  it('moves a target as a slip with its note, and show prints the planned day and each slip', async () => {
    const kit = await withGoals();
    kit.clock.advance(DAY_MS);
    const moved = await kit.run(['goal', 'set', 'A1', '--target', '2030-02-15', '--note', 'the vendor is late', '--session', 'lead']);
    ok(moved);
    assert.deepEqual(moved.stdout, ['SET goal A1 2030-01-08 to 2030-02-15, 1 slip | Ship the beta']);
    kit.clock.advance(DAY_MS);
    ok(await kit.run(['goal', 'set', 'A1', '--title', 'Ship the public beta', '--note', 'wider audience', '--session', 'lead']));
    const shown = await kit.run(['goal', 'show', 'A1']);
    ok(shown);
    assert.deepEqual(shown.stdout, [
      'A1 | Ship the public beta',
      '  window 2030-01-08 to 2030-02-15 (planned 2030-02-01)',
      '  added Tue 01-08 10:00 UTC by lead',
      '  parts A1.1',
      '  SLIPS 1',
      '    Wed 01-09 10:00 UTC lead: 2030-02-01 -> 2030-02-15 | the vendor is late',
    ]);
    const part = await kit.run(['goal', 'show', 'A1.1']);
    assert.deepEqual(part.stdout, ['A1.1 | Login works', '  window 2030-01-09 to 2030-01-20', '  added Tue 01-08 10:00 UTC by lead', '  part of A1', '  SLIPS 0']);
  });

  it('refuses a set by another session, of an unknown goal or that changes nothing, and needs a note', async () => {
    const kit = await withGoals();
    const before = await goalsText(kit);
    const other = await kit.run(['goal', 'set', 'A1', '--target', '2030-02-15', '--note', 'later', '--session', 'bravo']);
    assert.equal(other.code, EXIT.refused);
    assert.match(said(other), /only the lead \(app-lead\) adds and changes the team's goals/);
    const unknown = await kit.run(['goal', 'set', 'B9', '--target', '2030-02-15', '--note', 'later', '--session', 'lead']);
    assert.equal(unknown.code, EXIT.refused);
    assert.match(said(unknown), /goal B9 does not exist; add it with goal add/);
    const same = await kit.run(['goal', 'set', 'A1', '--target', '2030-02-01', '--note', 'no change', '--session', 'lead']);
    assert.equal(same.code, EXIT.refused);
    assert.match(said(same), /goal A1 already reads so; nothing to change/);
    const nothing = await kit.run(['goal', 'set', 'A1', '--note', 'no fields', '--session', 'lead']);
    assert.equal(nothing.code, EXIT.refused);
    assert.match(said(nothing), /goal set changes --target, --title or both/);
    const early = await kit.run(['goal', 'set', 'A1', '--target', '2030-01-01', '--note', 'too early', '--session', 'lead']);
    assert.equal(early.code, EXIT.refused);
    assert.match(said(early), /--target 2030-01-01 is before the goal's start 2030-01-08/);
    const unnoted = await kit.run(['goal', 'set', 'A1', '--target', '2030-02-15', '--session', 'lead']);
    assert.equal(unnoted.code, EXIT.usage);
    assert.equal(await goalsText(kit), before);
  });

  it('refuses to show a goal the team does not have', async () => {
    const kit = await withGoals();
    const shown = await kit.run(['goal', 'show', 'B1']);
    assert.equal(shown.code, EXIT.refused);
    assert.match(said(shown), /B1 is not a goal of the team: teamrig goal list lists them/);
  });
});

describe('runCli: goal list', () => {
  it('says how to add the first goal when there is none', async () => {
    const listed = await new CliHarness().run(['goal', 'list']);
    ok(listed);
    assert.deepEqual(listed.stdout, ['GOALS 0: the lead adds one with teamrig goal add <tag> --title "<title>" --target <YYYY-MM-DD>']);
  });

  it('warns about lines that fold to no goal and lists the rest', async () => {
    const kit = await withGoals();
    await kit.files.append(GOALS_PATH, 'not json\n{"v":1,"at":"2030-01-08T11:00:00.000Z","by":"lead","type":"goal-set","tag":"Z9","note":"no such goal"}\n');
    const listed = await kit.run(['goal', 'list']);
    ok(listed);
    assert.deepEqual(listed.stderr, [`WARN ${GOALS_PATH}: 1 unreadable line(s), 0 line(s) from a newer teamrig, 1 record(s) naming no goal or a second add`]);
    assert.equal(listed.stdout.length, 3);
  });
});

describe('goalTree', () => {
  function goal(tag: string, parent: string | null): Goal {
    return { tag, title: tag, start: '2030-01-08', target: '2030-02-01', parent, addedAt: '2030-01-08T10:00:00.000Z', addedBy: 'lead', slips: [] };
  }

  it('puts a goal whose parent is not recorded at the top, in the order added', () => {
    const goals = new Map([['B1', goal('B1', 'X0')], ['A1', goal('A1', null)], ['A1.1', goal('A1.1', 'A1')]]);
    assert.deepEqual(
      goalTree(goals).map(({ goal: each, depth }) => `${each.tag}@${depth}`),
      ['B1@0', 'A1@0', 'A1.1@1'],
    );
  });
});
