import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MeterLog } from '../../budget/calibration.ts';
import { EVENT_VERSION, type RegisterEvent, type TaskFields } from '../../register/events.ts';
import type { Goal } from '../../register/goals.ts';
import { registerHealth } from '../../register/stats-health.ts';
import { registerStats, type StatsTeam } from '../../register/stats.ts';
import { CliHarness, TEAM_HOME, type CliResult } from '../../testing/cli-harness.ts';
import { treeHarness } from '../../testing/team-tree.ts';
import { testZone } from '../../testing/zone.ts';
import { EXIT } from '../runtime.ts';
import { statsLines } from './stats.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };

function ok(result: CliResult): void {
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
}

/**
 * The harness's team over three days, on its UTC clock: on 01-08 the lead asks alpha for a p1 due 01-09 and bravo
 * for a p2, alpha files itself a bug, and bravo starts its task; on 01-09 bravo finishes and alpha drops the bug;
 * the stats run on 01-10, when alpha's p1 is a day late.
 */
async function seeded(): Promise<CliHarness> {
  const kit = new CliHarness();
  ok(await kit.run(['add', '--title', 'Login', '--description', 'what and why', '--priority', 'p1', '--owner', 'alpha', '--due', '2030-01-09', '--session', 'lead']));
  ok(await kit.run(['add', '--title', 'Docs', '--description', 'what and why', '--priority', 'p2', '--owner', 'bravo', '--session', 'lead']));
  ok(await kit.run(['add', '--title', 'Crash', '--description', 'what and why', '--priority', 'p2', '--type', 'bug', '--session', 'alpha']));
  ok(await kit.run(['set', 'T2', '--status', 'in-progress', '--session', 'bravo']));
  kit.clock.advance(DAY_MS);
  ok(await kit.run(['set', 'T2', '--status', 'done', '--note', 'shipped', '--evidence', 'abc1234', '--skill', 'none', '--followups', 'none', '--session', 'bravo']));
  ok(await kit.run(['set', 'T3', '--status', 'dropped', '--note', 'not a bug', '--session', 'alpha']));
  kit.clock.advance(DAY_MS);
  return kit;
}

describe('teamrig stats', () => {
  it("prints the team's Health tiles and each section's headline over the last 7 days, writing nothing", async () => {
    const kit = await seeded();
    const before = kit.files.paths().map((path) => [path, kit.files.get(path)]);
    const result = await kit.run(['stats']);
    assert.deepEqual(result, {
      code: EXIT.ok,
      stdout: [
        'STATS app, 7 d: 01-04 to 01-10',
        'HEALTH close/open 0.67 [bad] · backlog +1, 1 active [bad] · overdue 1, p1 1 [bad] · owner decisions 0 [good] · backlog clears never, at this rate [bad]',
        'FLOW opened 3, closed 2 (1 dropped), net +1; last 28 d net +1',
        'NEW WORK 3: self 1, owner 0, lead 2, github 0, session 0; 1 bug(s); no goal 3',
        'SPEED lead time median 1.0 d, p85 1.0 d (1 done); cycle time median 1.0 d, p85 1.0 d (1 started, 0 never)',
        'DELAYS overdue 1, p1 1; done by due 0 of 0; due moved 0',
        'WAITS 0 waiting; on the owner 0',
        'BUGS 0 active, 1 opened, 0 fixed',
        'PEOPLE bravo 1',
        'GOALS none; off goal: 1 of 1 done tasks (100%)',
        'AREAS 1 stands out: alpha p1 late 1 [warn]',
        'USE 0 of 7 days rolled up: teamrig budget rollup --apply writes the closed days',
      ],
      stderr: [],
    });
    assert.deepEqual(
      kit.files.paths().map((path) => [path, kit.files.get(path)]),
      before,
    );
  });

  it("marks the days the week sat at its usage limit, from the account's meter log", async () => {
    const kit = await seeded();
    const period = { start: Date.parse('2030-01-02T00:00:00Z'), end: Date.parse('2030-01-09T00:00:00Z'), w: 0, forecastPct: undefined };
    await new MeterLog(kit.files, join(TEAM_HOME, 'state', 'usage', 'meter-log.jsonl')).appendAll(
      [
        { ...period, at: Date.parse('2030-01-07T18:00:00Z'), usedPct: 99 },
        { ...period, at: Date.parse('2030-01-07T20:00:00Z'), usedPct: 100 },
      ],
      kit.clock.now(),
    );
    const result = await kit.run(['stats']);
    ok(result);
    assert.equal(result.stdout[2], 'FLOW opened 3, closed 2 (1 dropped), net +1; last 28 d net +1');
    assert.equal(result.stdout[3], 'LIMIT $ 01-07, 01-08: the week sat at its usage limit, so a quiet day there is no slack');
    assert.equal(result.stdout[4]?.startsWith('NEW WORK'), true);
  });

  it('reads the range asked for, and refuses one it does not know as a usage error', async () => {
    const kit = await seeded();
    const month = await kit.run(['stats', '--range', '30d']);
    ok(month);
    assert.equal(month.stdout[0], 'STATS app, 30 d: 2029-12-12 to 01-10');
    const year = await kit.run(['stats', '--range', '1y']);
    ok(year);
    assert.equal(year.stdout[0], 'STATS app, 365 d: 2029-01-11 to 01-10');
    const wrong = await kit.run(['stats', '--range', '14d']);
    assert.deepEqual(wrong.code, EXIT.usage);
    assert.match(wrong.stderr.join('\n'), /--range takes 7d, 30d, 90d, 180d, 1y or all, not 14d/);
  });

  it("reads one session's tasks with --session, by its id or its name", async () => {
    const kit = await seeded();
    const result = await kit.run(['stats', '--session', 'alpha']);
    ok(result);
    assert.equal(result.stdout[0], 'STATS app/alpha, 7 d: 01-04 to 01-10');
    assert.equal(result.stdout[2], 'FLOW opened 2, closed 1 (1 dropped), net +1; last 28 d net +1');
    assert.equal(result.stdout[8], 'PEOPLE none done');
    assert.deepEqual((await kit.run(['stats', '--session', 'app-alpha'])).stdout, result.stdout);
  });

  it('rolls up every team under the lead with --tree, the caller named by --session or the tab, and refuses it to another session', async () => {
    const kit = await treeHarness();
    ok(await kit.run(['add', '--title', 'Root task', '--description', 'what and why', '--priority', 'p2', '--owner', 'alpha', '--session', 'lead']));
    ok(await kit.run(['add', '--team', 'web', '--title', 'Ship login', '--description', 'what and why', '--priority', 'p2', '--session', 'lead']));
    const result = await kit.run(['stats', '--tree'], AS_LEAD);
    ok(result);
    assert.equal(result.stdout[0], 'STATS app, 7 d: 01-02 to 01-08 (tree: app, ops, web, ui)');
    assert.equal(result.stdout[2], 'FLOW opened 2, closed 0 (0 dropped), net +2; last 28 d net +2');
    assert.equal(result.stdout.at(-2), 'TEAMS app 1 active, overdue 0 · ops 0 active, overdue 0 · web 1 active, overdue 0 · ui 0 active, overdue 0');
    assert.deepEqual((await kit.run(['stats', '--tree', '--session', 'lead'])).stdout, result.stdout);
    const refused = await kit.run(['stats', '--tree', '--session', 'alpha']);
    assert.deepEqual(refused, { code: EXIT.refused, stdout: ["REFUSED --tree is for the team's lead (app/lead); app/alpha reads its own team's tasks without it"], stderr: [] });
  });
});

const FIELDS: TaskFields = { title: 'Ship it', description: null, owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], noGoal: false, week: null, after: [], size: null, type: null, critical: false, pin: null, workClass: null };

/** The tree app > web > ui and app > ops, one goal record each (A1, B1, D1 and C1), targeted for 2030-02-01. */
async function goalTree(): Promise<CliHarness> {
  const kit = await treeHarness();
  for (const [team, tag] of [['app', 'A1'], ['web', 'B1'], ['ops', 'C1'], ['ui', 'D1']] as const) {
    ok(await kit.run(['goal', 'add', tag, '--title', `Goal ${tag}`, '--target', '2030-02-01', '--session', 'lead'], { env: { TEAMRIG_TEAM: team } }));
  }
  return kit;
}

function goalsLine(result: CliResult): string | undefined {
  ok(result);
  return result.stdout.find((line) => line.startsWith('GOALS '));
}

describe('teamrig stats: the goals of the team and those above it (T1420)', () => {
  const UI = { env: { TEAMRIG_TEAM: 'ui' } };

  it("reads a team's own goals and those of the teams above it, none of a sibling's", async () => {
    const kit = await goalTree();
    assert.equal(goalsLine(await kit.run(['stats'], UI)), 'GOALS 3 on track; off goal: no task done');
  });

  it('gives a finer tag to a goal of a team above', async () => {
    const kit = await goalTree();
    ok(await kit.run(['add', '--title', 'Icons', '--description', 'what and why', '--priority', 'p2', '--owner', 'pixel', '--goals', 'A1.2', '--session', 'lead'], UI));
    assert.equal(goalsLine(await kit.run(['stats'], UI)), 'GOALS 2 on track, 1 at risk (A1); off goal: no task done');
  });

  it("reads every rolled team's goals with --tree", async () => {
    const kit = await goalTree();
    assert.equal(goalsLine(await kit.run(['stats', '--tree'], AS_LEAD)), 'GOALS 4 on track; off goal: no task done');
  });

  it("takes the nearest team's record of a tag", async () => {
    const kit = await goalTree();
    ok(await kit.run(['goal', 'add', 'A1', '--title', 'Nearer', '--target', '2030-03-01', '--session', 'lead'], UI));
    kit.clock.advance(30 * DAY_MS);
    assert.equal(goalsLine(await kit.run(['stats'], UI)), 'GOALS 1 on track, 2 late (B1, D1); off goal: no task done');
  });
});

const NOW = new Date('2030-01-10T10:00:00.000Z');

/** After the last day-end a usual reads: a task made then counts now and in no usual. */
const TODAY = '2030-01-10T08:00:00.000Z';

function create(id: string, at: string, fields: Partial<TaskFields> = {}): RegisterEvent {
  return { v: EVENT_VERSION, type: 'create', id, at, by: 'lead', task: { ...FIELDS, ...fields } };
}

function doneOn(id: string, at: string): RegisterEvent {
  return { v: EVENT_VERSION, type: 'status', id, at, by: 'alpha', status: 'done', note: 'n', evidence: null, skill: null };
}

function goalRecord(tag: string, target: string): Goal {
  return { tag, title: `Goal ${tag}`, start: '2030-01-01', target, parent: null, addedAt: '2030-01-01T00:00:00.000Z', addedBy: 'lead', slips: [], rank: null };
}

function teamOf(name: string, events: readonly RegisterEvent[]): StatsTeam {
  return { team: name, lead: 'lead', events };
}

describe('statsLines', () => {
  it("names each person's team in a tree, and each split day a task moved to another team", () => {
    const created = create('T1', '2030-01-05T10:00:00.000Z');
    const moved: RegisterEvent = { v: EVENT_VERSION, type: 'moved', id: 'T1', at: '2030-01-06T10:00:00.000Z', by: 'lead', to: 'web' };
    const done = doneOn('T1', '2030-01-08T10:00:00.000Z');
    const stats = registerStats({ teams: [teamOf('app', [created, moved]), teamOf('web', [created, done])], range: '7d', now: new Date('2030-01-10T10:00:00.000Z'), zone: testZone('UTC'), ownerMarker: 'owner' });
    const lines = statsLines({ stats, health: registerHealth(stats) }, 'app', ['app', 'web']);
    assert.equal(lines[0], 'STATS app, 7 d: 01-04 to 01-10 (tree: app, web)');
    assert.equal(lines[8], 'PEOPLE web/alpha 1');
    assert.equal(lines[9], 'GOALS none; off goal: 1 of 1 done tasks (100%)');
    assert.equal(lines[10], 'AREAS none stand out');
    assert.equal(lines[11], 'TEAMS app 0 active, overdue 0 · web 0 active, overdue 0');
    assert.equal(lines[12], 'SPLIT 01-06 1 task(s) moved app -> web: the chart of app before it lacks them');
    assert.equal(lines.length, 13);
  });

  it('counts the goals by state, naming those at risk and late, then the share of done tasks that served no goal', () => {
    const at = '2030-01-05T10:00:00.000Z';
    const closed = '2030-01-08T10:00:00.000Z';
    const events = [create('T1', at, { goals: ['R1'] }), create('T2', at, { goals: ['R2'] }), create('T3', at, { goals: ['R4'] }), doneOn('T3', closed), create('T4', at), doneOn('T4', closed)];
    const goals = new Map([goalRecord('R1', '2030-02-01'), goalRecord('R2', '2030-01-05'), goalRecord('R3', '2030-02-01'), goalRecord('R4', '2030-02-01')].map((goal) => [goal.tag, goal]));
    const stats = registerStats({ teams: [teamOf('app', events)], range: '7d', now: NOW, zone: testZone('UTC'), ownerMarker: 'owner', goals });
    const lines = statsLines({ stats, health: registerHealth(stats) }, 'app', ['app']);
    assert.equal(lines.find((line) => line.startsWith('GOALS ')), 'GOALS 1 done, 1 on track, 1 at risk (R1), 1 late (R2); off goal: 1 of 2 done tasks (50%)');
  });

  function areasLine(teams: readonly StatsTeam[], names: readonly string[]): string | undefined {
    const stats = registerStats({ teams, range: '7d', now: NOW, zone: testZone('UTC'), ownerMarker: 'owner' });
    return statsLines({ stats, health: registerHealth(stats) }, 'app', names).find((line) => line.startsWith('AREAS'));
  }

  function owned(first: number, owners: readonly string[], fields: Partial<TaskFields> = {}): RegisterEvent[] {
    return owners.map((owner, index) => create(`T${first + index}`, TODAY, { owner, ...fields }));
  }

  const QUIET = ['bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india'];

  it('names the sessions that stand out with each cell not good, the low share in percent', () => {
    const events = [...owned(1, QUIET), ...owned(11, ['alpha', 'alpha', 'alpha'], { type: 'bug', priority: 3 })];
    assert.equal(areasLine([teamOf('app', events)], ['app']), 'AREAS 1 stands out: alpha bugs 3 [bad], low 100% [bad]');
  });

  it('puts whole teams first, by name, and a tree names each session with its team', () => {
    const bugs = owned(11, ['alpha', 'alpha', 'alpha'], { type: 'bug' });
    const line = areasLine([teamOf('app', [...owned(1, QUIET), ...bugs]), teamOf('web', owned(21, ['kilo'])), teamOf('ops', owned(31, ['lima'])), teamOf('ui', owned(41, ['mike']))], ['app', 'web', 'ops', 'ui']);
    assert.equal(line, 'AREAS 2 stand out: app bugs 3 [bad]; app/alpha bugs 3 [bad]');
  });

  it('names six areas and counts the rest', () => {
    const owners = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
    const bugs = owners.flatMap((owner, index) => owned(100 + 10 * index, [owner, owner, owner], { type: 'bug' }));
    const quiet = Array.from({ length: 24 }, (_, index) => `q${index}`);
    const line = areasLine([teamOf('app', [...owned(1, quiet), ...bugs])], ['app']);
    assert.match(line ?? '', /^AREAS 8 stand out: a1 bugs 3 \[bad\]; .*; a6 bugs 3 \[bad\]; 2 more$/);
  });
});
