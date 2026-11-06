import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DEFAULT_REGISTER } from '../config/defaults.ts';
import { formatConfig } from '../config/load.ts';
import type { GoalsMode } from '../config/types.ts';
import { KIT, type CliHarness, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { SUB_TEAMS, teamConfigOf, teamHomeOf, treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';
import { KitTreeGoals } from './tree-goals.ts';

const UI = { env: { TEAMRIG_TEAM: 'ui' } };
/** The lead of team ui adds pixel a p2 task titled `title`. */
function addPixel(title = 'New icons'): string[] {
  return ['add', '--title', title, '--description', 'what and why', '--priority', 'p2', '--owner', 'pixel', '--session', 'lead'];
}

/** A team's goal records file. */
function goalsOf(team: string): string {
  return join(teamHomeOf(team), 'state', 'goals.jsonl');
}

/** The refusal of a goal tag that no goal record of team ui or a team above it holds. */
function unknownGoal(tag: string): string {
  return `REFUSED goal ${tag} is not a goal record of the team or a team above: teamrig goal list lists them`;
}

function ok(result: CliResult): void {
  assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
}

/** The lead of `team` adds goal `tag`, targeted for 2030-02-01. */
async function addGoal(kit: CliHarness, team: string, tag: string): Promise<void> {
  ok(await kit.run(['goal', 'add', tag, '--title', `Goal ${tag}`, '--target', '2030-02-01', '--session', 'lead'], { env: { TEAMRIG_TEAM: team } }));
}

/**
 * The tree app > web > ui and app > ops, each team with one goal record (A1 on app, B1 on web, C1 on ops, D1 on ui),
 * team ui holding its tasks' goal tags to them under `register.goals` `goals`.
 */
async function goalTree(goals: string): Promise<CliHarness> {
  const kit = await treeHarness();
  await kit.files.write(teamConfigOf('ui'), formatConfig({ ...SUB_TEAMS['ui'], register: { goals } }));
  for (const [team, tag] of [['app', 'A1'], ['web', 'B1'], ['ops', 'C1'], ['ui', 'D1']] as const) {
    await addGoal(kit, team, tag);
  }
  return kit;
}

/** What {@link KitTreeGoals.all} reads for `team`, under its `register.goals`, by tag and title. */
async function allGoalsOf(kit: CliHarness, team: string, goals: GoalsMode): Promise<Record<string, string>> {
  const paths = { team, goals: goalsOf(team) };
  const parent = team === 'app' ? {} : { team: { id: team, parent: team === 'ui' ? 'web' : 'app' } };
  const all = await new KitTreeGoals(kit.runtime(), paths, { ...parent, register: { ...DEFAULT_REGISTER, goals } }).all();
  return Object.fromEntries([...all].map(([tag, goal]) => [tag, goal.title]));
}

describe('KitTreeGoals.all: every goal a task may serve, for its rank (T2076)', () => {
  it("reads the team's own goals and each team's above it, never a sibling's", async () => {
    const kit = await goalTree('checked');
    assert.deepEqual(await allGoalsOf(kit, 'ui', 'checked'), { A1: 'Goal A1', B1: 'Goal B1', D1: 'Goal D1' });
  });

  it('reads them under free too, as a rank counts whatever register.goals says', async () => {
    const kit = await goalTree('free');
    assert.deepEqual(await allGoalsOf(kit, 'ui', 'free'), { A1: 'Goal A1', B1: 'Goal B1', D1: 'Goal D1' });
  });

  it('reads a tag two teams hold as the nearest team holds it', async () => {
    const kit = await goalTree('checked');
    ok(await kit.run(['goal', 'add', 'A1', '--title', 'Web view of A1', '--target', '2030-02-01', '--session', 'lead'], { env: { TEAMRIG_TEAM: 'web' } }));
    assert.equal((await allGoalsOf(kit, 'ui', 'checked'))['A1'], 'Web view of A1');
    ok(await kit.run(['goal', 'add', 'A1', '--title', 'Ui view of A1', '--target', '2030-02-01', '--session', 'lead'], UI));
    assert.equal((await allGoalsOf(kit, 'ui', 'checked'))['A1'], 'Ui view of A1');
  });

  it('reads a root team from its own file, without the tree', async () => {
    const kit = await goalTree('checked');
    const files = new FaultyFiles(kit.files).fail('list', join(KIT, 'teams'), systemError('EACCES'));
    const all = await new KitTreeGoals(kit.runtime({ files }), { team: 'app', goals: goalsOf('app') }, { register: DEFAULT_REGISTER }).all();
    assert.deepEqual([...all.keys()], ['A1']);
  });
});

describe('register.goals: goal tags held to the goal records of the team and those above it (T1730)', () => {
  it("takes a tag of the team's own goal records or a team's above it, and refuses a sibling team's", async () => {
    const kit = await goalTree('checked');
    for (const tag of ['A1', 'B1', 'D1']) {
      const added = await kit.run([...addPixel(`New icons for ${tag}`), '--goals', tag], UI);
      ok(added);
      assert.match(added.stdout[0] ?? '', /^ADDED T\d+ open, p2, owner pixel/, tag);
    }
    const sibling = await kit.run([...addPixel(), '--goals', 'C1'], UI);
    assert.deepEqual([sibling.code, sibling.stdout], [EXIT.refused, [unknownGoal('C1')]]);
    const update = await kit.run(['update', 'T1', '--goals', 'A1,C1', '--session', 'pixel'], UI);
    assert.deepEqual([update.code, update.stdout], [EXIT.refused, [unknownGoal('C1')]]);
  });

  it("holds a task another team's lead hands the team to the receiving team's goal records", async () => {
    const kit = await goalTree('checked');
    const handed = ['add', '--team', 'ui', '--owner', 'pixel', '--title', 'New icons', '--description', 'what and why', '--priority', 'p2', '--session', 'lead'];
    const refused = await kit.run([...handed, '--goals', 'C1']);
    assert.deepEqual([refused.code, refused.stdout], [EXIT.refused, [unknownGoal('C1')]]);
    ok(await kit.run([...handed, '--goals', 'D1']));
  });

  it('asks an owner-asked task of the team to name its goal under required', async () => {
    const kit = await goalTree('required');
    const unnamed = await kit.run([...addPixel(), '--source', 'owner'], UI);
    assert.deepEqual([unnamed.code, unnamed.stdout], [EXIT.refused, ['REFUSED an owner-asked task names its goal: --goals <tag>, or --goals none (register.goals is required)']]);
    ok(await kit.run([...addPixel(), '--source', 'owner', '--goals', 'none'], UI));
    ok(await kit.run([...addPixel('Newer icons'), '--source', 'owner', '--goals', 'A1'], UI));
  });

  it('reads no goal records under free, so any tag passes', async () => {
    const kit = await treeHarness();
    const files = new FaultyFiles(kit.files).fail('read', goalsOf('ui'), systemError('EACCES'));
    ok(await kit.run([...addPixel(), '--goals', 'Z9'], { ...UI, files }));
  });

  it("holds a root team's tags to its own goal records", async () => {
    const kit = await treeHarness({ register: { goals: 'checked' } });
    await addGoal(kit, 'app', 'A1');
    const add = ['add', '--title', 'Ship login', '--description', 'what and why', '--priority', 'p2', '--session', 'lead'];
    ok(await kit.run([...add, '--goals', 'A1']));
    const refused = await kit.run([...add, '--goals', 'Z9']);
    assert.deepEqual([refused.code, refused.stdout], [EXIT.refused, [unknownGoal('Z9')]]);
  });
});
