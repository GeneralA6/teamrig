import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EMPTY_USAGE, UsageStore } from '../budget/store.ts';
import type { JsonRecord } from '../core/guards.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, contextOf } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { ok } from '../testing/hired-team.ts';
import { treeHarness } from '../testing/team-tree.ts';

/** The harness clock is 2030-01-08 10:00 UTC; a weekly limit of 1,000M W makes 1% of the week 10M W. */
const LIMITED: JsonRecord = { ...TEAM, budget: { weeklyLimitW: 1_000_000_000 } };
const DAY = '2030-01-08';
const ROW = /^\s*(T\d+) /;

/** Alpha takes a p2 task titled `title`, with `flags` on its `add`. */
async function add(kit: CliHarness, title: string, ...flags: readonly string[]): Promise<void> {
  ok(await kit.run(['add', '--owner', 'alpha', '--title', title, '--description', 'what and why', '--priority', 'p2', ...flags, '--session', 'lead']));
}

/** The meter's store of alpha's use today, `byTask` in W. */
async function spend(kit: CliHarness, byTask: Readonly<Record<string, number>>): Promise<void> {
  const store = new UsageStore(kit.files, join(TEAM_HOME, 'state', 'usage'));
  const { rev } = await store.load('alpha');
  assert.equal(await store.save('alpha', { ...EMPTY_USAGE, byTask: { [DAY]: byTask } }, rev), true);
}

/** Alpha finishes `id`. */
async function finish(kit: CliHarness, id: string): Promise<void> {
  ok(await kit.run(['set', id, '--status', 'in-progress', '--session', 'alpha']));
  ok(await kit.run(['set', id, '--status', 'done', '--note', 'shipped', '--evidence', 'shipped', '--skill', 'none', '--followups', 'none', '--session', 'alpha']));
}

/** The rows of alpha's list, in its order. */
async function rows(kit: CliHarness): Promise<string[]> {
  return ok(await kit.run(['list', '--session', 'alpha'])).stdout.filter((line) => ROW.test(line));
}

/** The ids of `lines` that are task rows, in order. */
function idsOf(lines: readonly string[]): string[] {
  return lines.flatMap((line) => ROW.exec(line)?.[1] ?? []);
}

describe("teamRanking: a team's tree ranks by its focus, sizes and spend (T2076)", () => {
  it('ranks the smaller of two like tasks first, as a score divides by size', async () => {
    const kit = new CliHarness(LIMITED);
    await add(kit, 'Big', '--size', '2');
    await add(kit, 'Small', '--size', '0.5');
    const [first, second] = await rows(kit);
    assert.match(first ?? '', /^T2 open, Improvements, score 2, p2/);
    assert.match(second ?? '', /^T1 open, Improvements, score 0\.5, p2/);
  });

  it('ranks an unsized task by what its spend leaves of the default size (T2109)', async () => {
    const kit = new CliHarness(LIMITED);
    await add(kit, 'Sized', '--size', '0.25');
    await add(kit, 'Unsized');
    await spend(kit, { T2: 1_500_000 });
    const [first, second] = await rows(kit);
    assert.match(first ?? '', /^T2 open, Improvements, score 6\.67, p2/, 'spent 0.15% of the default 0.3%');
    assert.match(second ?? '', /^T1 open, Improvements, score 4, p2/);
  });

  it('ranks a sized task by what its spend leaves of its size, and one past it at the floor (T2109)', async () => {
    const kit = new CliHarness(LIMITED);
    await add(kit, 'Half done', '--size', '1');
    await add(kit, 'Overrun', '--size', '0.1');
    await spend(kit, { T1: 5_000_000, T2: 10_000_000 });
    const [first, second] = await rows(kit);
    assert.match(first ?? '', /^T2 open, Improvements, score 20, p2/, 'spent 1% of 0.1%: the floor of 0.05%');
    assert.match(second ?? '', /^T1 open, Improvements, score 2, p2/, 'spent 0.5% of 1%');
  });

  it('counts a re-sized task from its new size, which was what was left then (T2109)', async () => {
    const kit = new CliHarness(LIMITED);
    await add(kit, 'Re-sized');
    await spend(kit, { T1: 5_000_000 });
    ok(await kit.run(['update', 'T1', '--size', '0.4', '--session', 'alpha']));
    assert.match((await rows(kit))[0] ?? '', /^T1 open, Improvements, score 2\.5, p2/, 'the 0.5% spent before it was sized comes off nothing');
    await spend(kit, { T1: 6_000_000 });
    assert.match((await rows(kit))[0] ?? '', /^T1 open, Improvements, score 3\.33, p2/, 'the 0.1% spent since leaves 0.3%');
  });

  it('sizes an unsized task, with no spend, by the done tasks of its class and type', async () => {
    const kit = new CliHarness(LIMITED);
    await add(kit, 'Done like it', '--class', 'Maintenance');
    await add(kit, 'Unsized', '--class', 'Maintenance');
    await add(kit, 'Other class');
    await spend(kit, { T1: 2_000_000 });
    await finish(kit, 'T1');
    const [like, other] = await rows(kit);
    assert.match(like ?? '', /^T2 open, Maintenance, score 50, p2/, 'value 10 over the like median of 0.2%');
    assert.match(other ?? '', /^T3 open, Improvements, score 3\.33, p2/, 'no like task: the default size');
  });

  it("measures a like task by its whole cost, not what it spent since it was sized (T2096's review)", async () => {
    const kit = new CliHarness(LIMITED);
    await add(kit, 'Sized late');
    await add(kit, 'Unsized');
    await spend(kit, { T1: 2_000_000 });
    ok(await kit.run(['update', 'T1', '--size', '0.2', '--session', 'alpha']));
    await finish(kit, 'T1');
    const [row] = await rows(kit);
    assert.match(row ?? '', /^T2 open, Improvements, score 5, p2/, 'a median of 0.2%, though T1 spent nothing past its size base');
  });

  it('falls to the default size while the W of one percent is unknown', async () => {
    const kit = new CliHarness(TEAM);
    await add(kit, 'Sized', '--size', '0.25');
    await add(kit, 'Unsized');
    await spend(kit, { T2: 1_000_000 });
    const [first, second] = await rows(kit);
    assert.match(first ?? '', /^T1 open, Improvements, score 4, p2/);
    assert.match(second ?? '', /^T2 open, Improvements, score 3\.33, p2/);
  });

  it('still lists with a use store it cannot read, the tasks falling to their sizes', async () => {
    const kit = new CliHarness(LIMITED);
    await add(kit, 'Sized', '--size', '0.25');
    await add(kit, 'Unsized');
    await spend(kit, { T2: 1_000_000 });
    const files = new FaultyFiles(kit.files).fail('read', join(TEAM_HOME, 'state', 'usage', 'alpha.json'), systemError('EACCES'));
    const listed = ok(await kit.run(['list', '--session', 'alpha'], { files })).stdout.filter((line) => ROW.test(line));
    assert.match(listed[0] ?? '', /^T1 open, Improvements, score 4, p2/);
    assert.match(listed[1] ?? '', /^T2 open, Improvements, score 3\.33, p2/, 'its spend of 0.1% unread: the default size');
  });

  it('values a Roadmap task by the rank of the goal it serves, and names the goal in its reason', async () => {
    const kit = new CliHarness(LIMITED);
    ok(await kit.run(['goal', 'add', 'A1', '--title', 'Ship the beta', '--target', '2030-02-01', '--session', 'lead']));
    ok(await kit.run(['goal', 'rank', 'A1', '1', '--session', 'lead']));
    await add(kit, 'No goal', '--class', 'Roadmap');
    await add(kit, 'On the goal', '--class', 'Roadmap', '--goals', 'A1');
    const [first, second] = await rows(kit);
    assert.match(first ?? '', /^T2 open, Roadmap, score 66\.67, p2, .*ahead: score 66\.67 \(A1 #1\)$/, 'rank 1 is worth 20, over the default size of 0.3%');
    assert.match(second ?? '', /^T1 open, Roadmap, score 10, p2/, 'no ranked goal: the unranked value of 3');
  });

  it("reads the rank of a goal held by a team above the task's own", async () => {
    const kit = await treeHarness();
    const UI = { env: { TEAMRIG_TEAM: 'ui' } };
    ok(await kit.run(['goal', 'add', 'A1', '--title', 'Ship the beta', '--target', '2030-02-01', '--session', 'lead']));
    ok(await kit.run(['goal', 'rank', 'A1', '1', '--session', 'lead']));
    ok(await kit.run(['add', '--owner', 'pixel', '--title', 'New icons', '--description', 'what and why', '--priority', 'p2', '--class', 'Roadmap', '--goals', 'A1', '--session', 'lead'], UI));
    const listed = ok(await kit.run(['list', '--session', 'pixel'], UI)).stdout.filter((line) => ROW.test(line));
    assert.match(listed[0] ?? '', /^T1 open, Roadmap, score 66\.67, p2/);
  });

  it('gives list, plan, start and the start note one order', async () => {
    const kit = new CliHarness(LIMITED);
    await add(kit, 'Big', '--size', '2', '--week', '2030-01-07');
    await add(kit, 'Small', '--size', '0.5', '--week', '2030-01-07');
    const expected = ['T2', 'T1'];
    assert.deepEqual(idsOf(await rows(kit)), expected);
    const plan = ok(await kit.run(['plan', '--session', 'lead'])).stdout.join('\n');
    assert.deepEqual([...plan.matchAll(/\*\*(T\d+)\*\*/g)].map((match) => match[1]), expected);
    assert.deepEqual(idsOf(ok(await kit.run(['start', '--session', 'alpha'])).stdout).slice(0, 2), expected);
    const stdin = JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, source: 'compact' });
    const note = contextOf(await kit.run(['hook', 'session-start'], { env: { TEAMRIG_SESSION: 'alpha' }, stdin }));
    const live = note.slice(note.indexOf('LIVE TASKS of alpha')).split('\n');
    assert.deepEqual(idsOf(live), expected, note);
  });
});
