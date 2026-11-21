import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../../core/guards.ts';
import { INTERFACE_VERSION } from '../../interface/index.ts';
import { layoutPaths } from '../../register/layout.ts';
import { CliHarness, TEAM_HOME, type RunOptions } from '../../testing/cli-harness.ts';
import { normalisePath } from '../../testing/memory-files.ts';
import { problemsOf, rowsOf, served } from '../../testing/read-answers.ts';
import { rotateRegister } from '../../testing/rotation.ts';
import { teamEventsOf, teamHomeOf, treeHarness } from '../../testing/team-tree.ts';
import { WatchedFiles } from '../../testing/watched-files.ts';
import { EXIT } from '../runtime.ts';

const READ_PLAN = ['read', 'plan', '--json'] as const;
const DAY_MS = 86_400_000;
const AS_WEB: RunOptions = { env: { TEAMRIG_TEAM: 'web' } };
const AS_UI: RunOptions = { env: { TEAMRIG_TEAM: 'ui' } };
/** A title of the root team's task, which no plan of a team below may serve. */
const ROOT_TITLE = 'Rotate the signing key';

async function ok(kit: CliHarness, argv: readonly string[], options: RunOptions = {}): Promise<readonly string[]> {
  const result = await kit.run(argv, options);
  assert.equal(result.code, EXIT.ok, [...argv, ...result.stdout, ...result.stderr].join(' '));
  return result.stdout;
}

/** Adds a p2 task as the lead; `more` may name another priority. */
async function add(kit: CliHarness, title: string, owner: string, more: readonly string[] = [], options: RunOptions = {}): Promise<void> {
  const priority = more.includes('--priority') ? [] : ['--priority', 'p2'];
  await ok(kit, ['add', '--session', 'lead', '--title', title, '--description', 'what and why', '--owner', owner, ...priority, ...more], options);
}

function plannedOf(answer: JsonRecord): JsonRecord[] {
  return rowsOf(answer, 'tasks');
}

function idsOf(answer: JsonRecord): string[] {
  return plannedOf(answer).map((task) => String(task['id']));
}

function plannedTask(answer: JsonRecord, id: string): JsonRecord {
  const task = plannedOf(answer).find((candidate) => candidate['id'] === id);
  assert.ok(task !== undefined, `${id} is in the plan`);
  return task;
}

/** The ids `teamrig list` prints for a session, in its order. */
async function listed(kit: CliHarness, session: string): Promise<string[]> {
  return (await ok(kit, ['list', '--session', session])).flatMap((line) => /^(T\d+) /.exec(line)?.[1] ?? []);
}

/** App holds T1, its lead's; web holds T2, planned after it and owned by back. */
async function needingTheRoot(): Promise<CliHarness> {
  const kit = await treeHarness();
  await add(kit, ROOT_TITLE, 'lead');
  await add(kit, 'Sign the web build', 'back', ['--after', 'T1'], AS_WEB);
  return kit;
}

describe('teamrig read plan', () => {
  it('answers one JSON line with the envelope, when it was judged and the week in force', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    const answer = served(await kit.run(READ_PLAN));
    assert.deepEqual([answer['interface'], answer['document'], answer['problems'], answer['week'], answer['finished']], [INTERFACE_VERSION, 'plan', [], null, []]);
    assert.match(String(answer['revision']), /^[0-9a-f]{16}$/);
    assert.equal(answer['at'], new Date(kit.clock.now()).toISOString());
    assert.deepEqual(idsOf(answer), ['T1']);
    assert.deepEqual(
      [plannedTask(answer, 'T1')['ready'], plannedTask(answer, 'T1')['needs'], plannedTask(answer, 'T1')['neededBy'], plannedTask(answer, 'T1')['next']],
      [true, [], [], { kind: 'work', who: 'alpha', task: 'T1', behind: null }],
    );
  });

  it('serves the tasks in the order teamrig list prints them, and one session its own with --owner', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    await add(kit, 'Write the guide', 'bravo', ['--due', '2030-01-20']);
    await add(kit, 'Fix the hook', 'alpha', ['--priority', 'p0']);
    await add(kit, 'Sort the board', 'alpha', ['--due', '2030-01-12']);
    await add(kit, 'Trim the log', 'bravo', ['--priority', 'p1']);
    await ok(kit, ['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
    const every = idsOf(served(await kit.run(READ_PLAN)));
    assert.deepEqual([...every].sort(), ['T1', 'T2', 'T3', 'T4', 'T5']);
    for (const session of ['alpha', 'bravo']) {
      const own = idsOf(served(await kit.run([...READ_PLAN, '--owner', session])));
      assert.deepEqual(own, await listed(kit, session), `${session}'s plan is its list`);
      assert.deepEqual(own, every.filter((id) => own.includes(id)), `${session}'s tasks keep the team's order`);
    }
    assert.equal((await listed(kit, 'alpha')).length, 3);
  });

  it('names who else needs a task, and a finished task by its work class alone', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    await add(kit, 'Write the guide', 'bravo', ['--after', 'T1', '--due', '2030-01-20']);
    await add(kit, 'Drop the old flag', 'alpha');
    await ok(kit, ['set', 'T3', '--status', 'dropped', '--note', 'no longer wanted', '--session', 'alpha']);
    const result = await kit.run(READ_PLAN);
    const answer = served(result);
    assert.deepEqual(plannedTask(answer, 'T1')['neededBy'], [{ id: 'T2', owner: 'bravo', due: { due: '2030-01-20', at: '2030-01-20T23:59:59.999Z', from: null } }]);
    assert.deepEqual(plannedTask(answer, 'T1')['due'], { due: '2030-01-20', at: '2030-01-20T23:59:59.999Z', from: 'T2' });
    assert.deepEqual(answer['finished'], [{ id: 'T3', workClass: 'Improvements' }]);
    assert.deepEqual(idsOf(answer).includes('T3'), false);
    for (const title of ['Ship the gate', 'Write the guide', 'Drop the old flag']) {
      assert.equal(result.stdout.join('\n').includes(title), false, `no title is served: ${title}`);
    }
  });

  it('names a need another team of the tree holds by its id, team, owner and status, and nothing else of it', async () => {
    const kit = await needingTheRoot();
    const result = await kit.run(READ_PLAN, AS_WEB);
    const waiting = plannedTask(served(result), 'T2');
    assert.deepEqual(waiting['needs'], [{ id: 'T1', team: 'app', owner: 'lead', status: 'open' }]);
    assert.deepEqual([waiting['ready'], waiting['next']], [false, { kind: 'elsewhere', who: 'lead', task: 'T2', team: 'app', need: 'T1' }]);
    assert.deepEqual(idsOf(served(result)), ['T2']);
    assert.equal(result.stdout.join('\n').includes(ROOT_TITLE), false);
  });

  it('serves the plan of a team above with --team, and refuses a team below or beside', async () => {
    const kit = await needingTheRoot();
    const own = served(await kit.run(READ_PLAN));
    const fromBelow = served(await kit.run([...READ_PLAN, '--team', 'app'], AS_UI));
    assert.deepEqual([idsOf(fromBelow), plannedOf(fromBelow)], [['T1'], plannedOf(own)]);
    assert.deepEqual(await kit.run([...READ_PLAN, '--team', 'ui'], AS_WEB), {
      code: EXIT.refused,
      stdout: [],
      stderr: ['REFUSED read serves your own team (web) and the teams above it; --team ui names neither'],
    });
    assert.equal((await kit.run([...READ_PLAN, '--team', 'ops'], AS_UI)).code, EXIT.refused);
  });

  it('moves its revision when another register of the tree, a goals file or a metered spend moves', async () => {
    const kit = await needingTheRoot();
    const revision = async () => String(served(await kit.run(READ_PLAN, AS_WEB))['revision']);
    const first = await revision();
    assert.equal(await revision(), first, 'nothing moved');
    await ok(kit, ['set', 'T1', '--status', 'in-progress', '--session', 'lead']);
    const afterRegister = await revision();
    await ok(kit, ['goal', 'add', 'A1', '--title', 'A signed build', '--target', '2030-02-01', '--session', 'lead']);
    const afterGoal = await revision();
    await kit.files.write(join(teamHomeOf('web'), 'state', 'usage', 'back.json'), '{}\n');
    const afterSpend = await revision();
    assert.equal(new Set([first, afterRegister, afterGoal, afterSpend]).size, 4);
  });

  it('holds its revision as the clock runs, and says in validUntil when to ask again', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha', ['--due', '2030-01-30']);
    const before = served(await kit.run(READ_PLAN));
    const turn = Date.parse(String(before['validUntil']));
    assert.ok(turn > kit.clock.now() && turn <= Date.parse('2030-01-30T23:59:59.999Z'), String(before['validUntil']));
    kit.clock.advance(turn - kit.clock.now() + 1);
    const after = served(await kit.run(READ_PLAN));
    assert.equal(after['revision'], before['revision']);
    assert.ok(after['validUntil'] === null || Date.parse(String(after['validUntil'])) > turn, String(after['validUntil']));
    assert.equal(after['at'], new Date(turn + 1).toISOString());
  });

  it('serves a null validUntil when no answer turns with the clock', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    await ok(kit, ['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
    assert.equal(served(await kit.run(READ_PLAN))['validUntil'], null);
    kit.clock.advance(400 * DAY_MS);
    assert.equal(served(await kit.run(READ_PLAN))['validUntil'], null);
  });

  it('serves no task and says why when a register of the tree lost an archive segment, by its own team\'s path', async () => {
    const kit = await needingTheRoot();
    const events = teamEventsOf('app');
    const layout = layoutPaths(events);
    await rotateRegister(kit.files, events, { now: new Date(kit.clock.now()) });
    await kit.files.remove(layout.snapshot);
    await kit.files.remove(layout.segment(1));
    const broken = served(await kit.run(READ_PLAN, AS_WEB));
    const segment = normalisePath(layout.segment(1)).slice(normalisePath(teamHomeOf('app')).length);
    assert.deepEqual([plannedOf(broken), broken['finished']], [[], []]);
    assert.deepEqual(problemsOf(broken), [`app${segment}: missing, so a register of the team tree cannot be read and the plan cannot be judged`]);
  });

  it('writes no file', async () => {
    const kit = await needingTheRoot();
    const files = new WatchedFiles(kit.files);
    served(await kit.run(READ_PLAN, { ...AS_WEB, files }));
    served(await kit.run([...READ_PLAN, '--unless', 'plan=0123456789abcdef'], { ...AS_WEB, files }));
    assert.deepEqual(files.written(), []);
  });

  it('answers unchanged to a reader holding the revision', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    const held = String(served(await kit.run(READ_PLAN))['revision']);
    assert.deepEqual(served(await kit.run([...READ_PLAN, '--unless', `plan=${held}`])), { interface: INTERFACE_VERSION, document: 'plan', revision: held, unchanged: true });
  });
});

describe('the plan document beside the others', () => {
  it('is served with them in one run, in the order asked', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    const result = await kit.run(['read', 'tasks', 'plan', '--json']);
    assert.deepEqual([result.code, result.stderr, result.stdout.map((line) => /"document":"(\w+)"/.exec(line)?.[1])], [EXIT.ok, [], ['tasks', 'plan']]);
    assert.equal(TEAM_HOME, teamHomeOf('app'));
  });
});
