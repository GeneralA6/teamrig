import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { recordField, type JsonRecord } from '../../core/guards.ts';
import { INTERFACE_VERSION } from '../../interface/index.ts';
import { EVENT_WINDOW_DAYS } from '../../register/compaction.ts';
import { layoutPaths } from '../../register/layout.ts';
import { CliHarness, EVENTS_PATH, TEAM_HOME, type RunOptions } from '../../testing/cli-harness.ts';
import { normalisePath } from '../../testing/memory-files.ts';
import { problemsOf, rowsOf, served } from '../../testing/read-answers.ts';
import { rotateRegister } from '../../testing/rotation.ts';
import { treeHarness } from '../../testing/team-tree.ts';
import { WatchedFiles } from '../../testing/watched-files.ts';
import { EXIT } from '../runtime.ts';

const READ_STATS = ['read', 'stats', '--json'] as const;
const AS_UI: RunOptions = { env: { TEAMRIG_TEAM: 'ui' } };
const AS_WEB: RunOptions = { env: { TEAMRIG_TEAM: 'web' } };
const DAY_MS = 86_400_000;

async function ok(kit: CliHarness, argv: readonly string[], options: RunOptions = {}): Promise<void> {
  const result = await kit.run(argv, options);
  assert.equal(result.code, EXIT.ok, [...argv, ...result.stdout, ...result.stderr].join(' '));
}

/** Adds a task as the team's lead; the first of a register is T1. */
async function add(kit: CliHarness, title: string, owner: string, options: RunOptions = {}, more: readonly string[] = []): Promise<void> {
  await ok(kit, ['add', '--session', 'lead', '--title', title, '--description', 'what and why', '--priority', 'p2', '--owner', owner, ...more], options);
}

/** Every file with its bytes and its stamp, so a rewrite with the same bytes shows too. */
async function storeOf(kit: CliHarness): Promise<(string | undefined)[][]> {
  const rows: (string | undefined)[][] = [];
  for (const path of kit.files.paths()) {
    rows.push([path, kit.files.get(path), await kit.files.stamp(path)]);
  }
  return rows;
}

async function statsOf(kit: CliHarness, options: RunOptions = {}, more: readonly string[] = []): Promise<JsonRecord> {
  return served(await kit.run([...READ_STATS, ...more], options));
}

async function revisionOf(kit: CliHarness, more: readonly string[] = []): Promise<string> {
  return String((await statsOf(kit, {}, more))['revision']);
}

/** The ids a count of `behind` names. */
function behindOf(answer: JsonRecord, count: string): unknown {
  return recordField(answer, 'behind')?.[count];
}

/** T1 for alpha, done; T2 for bravo, still open. */
async function workedRegister(): Promise<CliHarness> {
  const kit = new CliHarness();
  await add(kit, 'Ship the gate', 'alpha');
  await add(kit, 'Write the guide', 'bravo');
  await ok(kit, ['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
  await ok(kit, ['set', 'T1', '--status', 'done', '--note', 'shipped', '--evidence', 'the gate passes', '--skill', 'none', '--followups', 'none', '--session', 'alpha']);
  return kit;
}

describe('teamrig read stats', () => {
  it('answers one JSON line with the envelope, the instant counted at, when it next goes stale and the range', async () => {
    const kit = await workedRegister();
    const answer = await statsOf(kit);
    assert.deepEqual(
      [answer['interface'], answer['document'], answer['problems'], answer['cuts'], answer['at'], answer['validUntil'], answer['range'], answer['session']],
      [INTERFACE_VERSION, 'stats', [], [], new Date(kit.clock.now()).toISOString(), '2030-01-09T00:00:00.000Z', '7d', null],
    );
    assert.match(String(answer['revision']), /^[0-9a-f]{16}$/);
    assert.equal(rowsOf(answer, 'days').length, 7);
  });

  it('counts a task opened and one done, each named by id with its slim row', async () => {
    const answer = await statsOf(await workedRegister());
    assert.deepEqual([answer['opened'], answer['closedTasks'], behindOf(answer, 'opened'), behindOf(answer, 'closed'), behindOf(answer, 'active')], [2, 1, ['T1', 'T2'], ['T1'], ['T2']]);
    assert.deepEqual(
      rowsOf(answer, 'tasks').map((task) => [task['id'], task['owner'], task['status']]),
      [
        ['T1', 'alpha', 'done'],
        ['T2', 'bravo', 'open'],
      ],
    );
  });

  it('counts one session’s tasks with --owner', async () => {
    const answer = await statsOf(await workedRegister(), {}, ['--owner', 'bravo']);
    assert.deepEqual([answer['session'], answer['opened'], answer['closedTasks'], behindOf(answer, 'opened')], ['bravo', 1, 0, ['T2']]);
  });

  it('counts over the range --range names', async () => {
    const answer = await statsOf(await workedRegister(), {}, ['--range', '30d']);
    assert.deepEqual([answer['range'], rowsOf(answer, 'days').length], ['30d', 30]);
  });

  it('refuses, as a usage error, --range without stats and a range it does not know', async () => {
    const kit = await workedRegister();
    const unasked = await kit.run(['read', 'tasks', '--json', '--range', '30d']);
    const unknown = await kit.run([...READ_STATS, '--range', '14d']);
    assert.deepEqual([unasked.code, unknown.code, unasked.stdout, unknown.stdout], [EXIT.usage, EXIT.usage, [], []]);
    assert.match(unasked.stderr.join('\n'), /--range names the days stats is counted over, and this run does not ask for stats/);
    assert.match(unknown.stderr.join('\n'), /--range takes 7d, 30d, 90d, 180d, 1y or all, not 14d/);
  });

  it('holds validUntil at an active task’s due when it comes before the day ends, and never at one past', async () => {
    const kit = await workedRegister();
    await add(kit, 'Answer the review', 'alpha', {}, ['--due', '2030-01-08 15:00']);
    await add(kit, 'Late already', 'alpha', {}, ['--due', '2030-01-08 09:00']);
    assert.equal((await statsOf(kit))['validUntil'], '2030-01-08T15:00:00.000Z');
  });

  it('counts the goals of the team, a task of one named under it', async () => {
    const kit = await workedRegister();
    await ok(kit, ['goal', 'add', 'A1', '--title', 'A signed build', '--target', '2030-02-01', '--session', 'lead']);
    await add(kit, 'Sign the build', 'alpha', {}, ['--goals', 'A1']);
    const goals = rowsOf(recordField(await statsOf(kit), 'goals') ?? {}, 'goals');
    assert.deepEqual(
      goals.map((goal) => [goal['tag'], goal['tasks']]),
      [['A1', ['T3']]],
    );
  });

  it('counts the register of a team above the caller’s with --team, and its own without', async () => {
    const kit = await treeHarness();
    await add(kit, 'Of web', 'front', AS_WEB);
    await add(kit, 'Of ui', 'pixel', AS_UI);
    await add(kit, 'Of ui too', 'pixel', AS_UI);
    assert.deepEqual([(await statsOf(kit, AS_UI, ['--team', 'web']))['opened'], (await statsOf(kit, AS_UI))['opened']], [1, 2]);
  });

  it('moves the revision with a register write and a goal write, never with the clock alone', async () => {
    const kit = await workedRegister();
    const first = await revisionOf(kit);
    assert.notEqual(await revisionOf(kit, ['--range', '30d']), first, 'each range is its own answer');
    kit.clock.advance(DAY_MS);
    assert.equal(await revisionOf(kit), first, 'the clock is no part of it: validUntil tells');
    await ok(kit, ['goal', 'add', 'A1', '--title', 'A signed build', '--target', '2030-02-01', '--session', 'lead']);
    const withGoal = await revisionOf(kit);
    assert.notEqual(withGoal, first);
    await ok(kit, ['set', 'T2', '--status', 'dropped', '--note', 'no longer wanted', '--session', 'bravo']);
    assert.notEqual(await revisionOf(kit), withGoal);
    const held = await revisionOf(kit);
    assert.deepEqual(served(await kit.run([...READ_STATS, '--unless', `stats=${held}`])), { interface: INTERFACE_VERSION, document: 'stats', revision: held, unchanged: true });
  });

  it('counts the events a rotation left to the archive', async () => {
    const kit = await workedRegister();
    kit.clock.advance((EVENT_WINDOW_DAYS + 1) * DAY_MS);
    await rotateRegister(kit.files, EVENTS_PATH, { now: new Date(kit.clock.now()) });
    const answer = await statsOf(kit);
    assert.deepEqual([answer['opened'], answer['closedTasks'], problemsOf(answer)], [2, 1, []]);
  });

  it('counts nothing and says why when an archive segment is gone', async () => {
    const kit = await workedRegister();
    const layout = layoutPaths(EVENTS_PATH);
    kit.clock.advance((EVENT_WINDOW_DAYS + 1) * DAY_MS);
    await rotateRegister(kit.files, EVENTS_PATH, { now: new Date(kit.clock.now()) });
    await kit.files.remove(layout.segment(1));
    const answer = await statsOf(kit);
    const segment1 = normalisePath(layout.segment(1)).slice(normalisePath(TEAM_HOME).length);
    assert.deepEqual([answer['opened'], problemsOf(answer)], [0, [`app${segment1}: missing, so the register's archive is incomplete and its numbers cannot be counted`]]);
  });

  it('writes no file and no folder counting a history read from the archive, served in full or as unchanged', async () => {
    const kit = await workedRegister();
    kit.clock.advance((EVENT_WINDOW_DAYS + 1) * DAY_MS);
    await rotateRegister(kit.files, EVENTS_PATH, { now: new Date(kit.clock.now()) });
    const before = await storeOf(kit);
    const files = new WatchedFiles(kit.files);
    const answer = served(await kit.run(READ_STATS, { files }));
    assert.equal(answer['opened'], 2);
    assert.ok(files.touched().includes(normalisePath(layoutPaths(EVENTS_PATH).segment(1))), 'the archive segment was read');
    const again = served(await kit.run([...READ_STATS, '--unless', `stats=${String(answer['revision'])}`], { files }));
    assert.equal(again['unchanged'], true);
    assert.deepEqual([files.written(), await storeOf(kit)], [[], before]);
  });

  it('writes no file and no folder in a team that has no state folder yet', async () => {
    const kit = new CliHarness();
    const state = `${normalisePath(join(TEAM_HOME, 'state'))}/`;
    assert.deepEqual(kit.files.paths().filter((path) => path.startsWith(state)), []);
    const before = await storeOf(kit);
    const files = new WatchedFiles(kit.files);
    assert.equal(served(await kit.run(READ_STATS, { files }))['opened'], 0);
    assert.deepEqual([files.written(), await storeOf(kit)], [[], before]);
  });
});
