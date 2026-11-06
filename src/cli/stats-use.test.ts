import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatRollup, ROLLUP_IN_STATE, rollupFileName, type TaskRow } from '../budget/rollup-file.ts';
import { CliHarness, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { teamHomeOf, treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK = '2030-01-07';
const NEXT_WEEK = '2030-01-14';
const NOTHING_ELSE = 'no task 0 W, 0 min';

function ok(result: CliResult): void {
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
}

function row(session: string, task: string | null, w: number, seconds: number): TaskRow {
  return { session, task, w, seconds };
}

function rollupPath(home: string, day: string): string {
  return join(home, 'state', ...ROLLUP_IN_STATE, rollupFileName(day));
}

async function rollup(kit: CliHarness, day: string, tasks: readonly TaskRow[], team = 'app'): Promise<void> {
  await kit.files.write(rollupPath(teamHomeOf(team), day), formatRollup({ day, team, rows: [], tasks }));
}

async function addTask(kit: CliHarness, title: string, ...flags: readonly string[]): Promise<void> {
  ok(await kit.run(['add', '--title', title, '--description', 'what and why', '--priority', 'p2', '--session', 'lead', ...flags]));
}

async function retag(kit: CliHarness, week: string): Promise<void> {
  ok(await kit.run(['update', 'T1', '--week', week, '--session', 'lead']));
}

function useIn(result: CliResult): string[] {
  ok(result);
  return result.stdout.filter((line) => line.startsWith('USE '));
}

/** The USE lines of `stats` a day after the harness's first day, so its rollups are of closed days. */
async function useNextDay(kit: CliHarness, ...flags: readonly string[]): Promise<string[]> {
  kit.clock.advance(DAY_MS);
  return useIn(await kit.run(['stats', ...flags]));
}

describe('teamrig stats: the USE lines', () => {
  it('splits the task W by the plan and by class, each against its target, the work with no task apart', async () => {
    const kit = new CliHarness();
    await addTask(kit, 'Planned', '--week', WEEK, '--class', 'Roadmap');
    await addTask(kit, 'Unplanned', '--class', 'Maintenance');
    await rollup(kit, '2030-01-08', [row('alpha', 'T1', 700, 600), row('bravo', 'T2', 300, 120), row('alpha', null, 500, 60)]);
    assert.deepEqual(await useNextDay(kit), [
      'USE 1 of 7 days rolled up: task work 1k W, 12 min; no task 500 W, 1 min',
      'USE planned 70% of task W, target 70%, gap +0: planned 700 W, 10 min; unplanned 300 W, 2 min',
      'USE Roadmap 70% of task W, target 60%, gap +10: planned 700 W, 10 min; unplanned 0 W, 0 min',
      'USE Maintenance 30% of task W, target 25%, gap +5: planned 0 W, 0 min; unplanned 300 W, 2 min',
      'USE Improvements 0% of task W, target 15%, gap -15: planned 0 W, 0 min; unplanned 0 W, 0 min',
    ]);
  });

  it('says none, with no gap, for a span whose work named no task', async () => {
    const kit = new CliHarness();
    await rollup(kit, '2030-01-08', [row('alpha', null, 500, 60)]);
    assert.deepEqual((await useNextDay(kit)).slice(0, 3), [
      'USE 1 of 7 days rolled up: task work 0 W, 0 min; no task 500 W, 1 min',
      'USE planned none of task W, target 70%: planned 0 W, 0 min; unplanned 0 W, 0 min',
      'USE Roadmap none of task W, target 60%: planned 0 W, 0 min; unplanned 0 W, 0 min',
    ]);
  });

  it('prints a class the allocation does not name with no target', async () => {
    const kit = new CliHarness({ ...TEAM, focus: { classes: ['Roadmap', 'Maintenance', 'Improvements', 'Research'] } });
    await addTask(kit, 'Look into it', '--class', 'Research');
    await rollup(kit, '2030-01-08', [row('alpha', 'T1', 500, 60)]);
    assert.equal((await useNextDay(kit)).at(-1), 'USE Research 100% of task W: planned 0 W, 0 min; unplanned 500 W, 1 min');
  });

  it("leaves the days before a retag planned: a day reads the tag in force then, not today's", async () => {
    const kit = new CliHarness();
    await addTask(kit, 'Moved on', '--week', WEEK);
    await rollup(kit, '2030-01-08', [row('alpha', 'T1', 600, 60)]);
    kit.clock.advance(2 * DAY_MS);
    await retag(kit, NEXT_WEEK);
    await rollup(kit, '2030-01-10', [row('alpha', 'T1', 400, 60)]);
    assert.equal((await useNextDay(kit))[1], 'USE planned 60% of task W, target 70%, gap -10: planned 600 W, 1 min; unplanned 400 W, 1 min');
  });

  it('reads a task tagged mid-week as planned from that day on, unplanned before it', async () => {
    const kit = new CliHarness();
    await addTask(kit, 'Picked up');
    await rollup(kit, '2030-01-08', [row('alpha', 'T1', 300, 60)]);
    kit.clock.advance(DAY_MS);
    await retag(kit, WEEK);
    await rollup(kit, '2030-01-09', [row('alpha', 'T1', 700, 60)]);
    assert.equal((await useNextDay(kit))[1], 'USE planned 70% of task W, target 70%, gap +0: planned 700 W, 1 min; unplanned 300 W, 1 min');
  });

  it('reads only the days of the range, and no other file of the folder', async () => {
    const kit = new CliHarness();
    await addTask(kit, 'Old work', '--week', WEEK);
    await rollup(kit, '2030-01-01', [row('alpha', 'T1', 900, 60)]);
    await kit.files.write(rollupPath(TEAM_HOME, '2030-01-02'), '{damaged');
    await kit.files.write(join(TEAM_HOME, 'state', ...ROLLUP_IN_STATE, 'notes.txt'), 'kept by hand');
    await rollup(kit, '2030-01-08', [row('alpha', 'T1', 100, 60)]);
    kit.clock.advance(DAY_MS);
    const result = await kit.run(['stats']);
    assert.equal(useIn(result)[0], `USE 1 of 7 days rolled up: task work 100 W, 1 min; ${NOTHING_ELSE}`);
    assert.deepEqual(result.stderr, []);
  });

  it("reads one session's rows with --session", async () => {
    const kit = new CliHarness();
    await addTask(kit, 'Shared', '--week', WEEK);
    await rollup(kit, '2030-01-08', [row('alpha', 'T1', 700, 60), row('bravo', 'T1', 300, 60), row('bravo', null, 50, 60)]);
    assert.equal((await useNextDay(kit, '--session', 'alpha'))[0], `USE 1 of 7 days rolled up: task work 700 W, 1 min; ${NOTHING_ELSE}`);
  });

  it("adds up a tree's teams with --tree, each task read in its own team, a day any team holds counted once", async () => {
    const kit = await treeHarness();
    await addTask(kit, 'Root task', '--week', WEEK, '--class', 'Roadmap');
    await addTask(kit, 'Ship login', '--team', 'web', '--class', 'Maintenance');
    await rollup(kit, '2030-01-08', [row('alpha', 'T1', 600, 60)]);
    await rollup(kit, '2030-01-08', [row('front', 'T2', 200, 60)], 'web');
    await rollup(kit, '2030-01-07', [row('front', 'T2', 200, 60)], 'web');
    assert.deepEqual((await useNextDay(kit, '--tree', '--session', 'lead')).slice(0, 4), [
      `USE 2 of 7 days rolled up: task work 1k W, 3 min; ${NOTHING_ELSE}`,
      'USE planned 60% of task W, target 70%, gap -10: planned 600 W, 1 min; unplanned 400 W, 2 min',
      'USE Roadmap 60% of task W, target 60%, gap +0: planned 600 W, 1 min; unplanned 0 W, 0 min',
      'USE Maintenance 40% of task W, target 25%, gap +15: planned 0 W, 0 min; unplanned 400 W, 2 min',
    ]);
  });

  it("reads a task another team holds by today's tag, as this team's events never name it", async () => {
    const kit = await treeHarness();
    await addTask(kit, 'Ship login', '--team', 'web', '--week', WEEK, '--class', 'Maintenance');
    await rollup(kit, '2030-01-08', [row('alpha', 'T1', 500, 60)]);
    const lines = await useNextDay(kit);
    assert.equal(lines[1], 'USE planned 100% of task W, target 70%, gap +30: planned 500 W, 1 min; unplanned 0 W, 0 min');
    assert.equal(lines[3], 'USE Maintenance 100% of task W, target 25%, gap +75: planned 500 W, 1 min; unplanned 0 W, 0 min');
  });

  it('reads a task no register holds as the default class, unplanned', async () => {
    const kit = new CliHarness();
    await rollup(kit, '2030-01-08', [row('alpha', 'T99', 500, 60)]);
    const lines = await useNextDay(kit);
    assert.equal(lines[1], 'USE planned 0% of task W, target 70%, gap -70: planned 0 W, 0 min; unplanned 500 W, 1 min');
    assert.equal(lines.at(-1), 'USE Improvements 100% of task W, target 15%, gap +85: planned 0 W, 0 min; unplanned 500 W, 1 min');
  });

  it('names a damaged file on stderr and leaves its day out, so it reads a day short, never a low day', async () => {
    const kit = new CliHarness();
    await addTask(kit, 'Read', '--week', WEEK);
    await rollup(kit, '2030-01-08', [row('alpha', 'T1', 500, 60)]);
    const damaged = rollupPath(TEAM_HOME, '2030-01-07');
    await kit.files.write(damaged, '{"v":1,"day":"2030-01-07"');
    kit.clock.advance(DAY_MS);
    const result = await kit.run(['stats']);
    assert.equal(useIn(result)[0], `USE 1 of 7 days rolled up: task work 500 W, 1 min; ${NOTHING_ELSE}`);
    assert.deepEqual(result.stderr, [`WARN ${damaged}: damaged or from a newer teamrig, left out of the USE lines`]);
  });
});
