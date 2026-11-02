import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MeterLog } from '../../budget/calibration.ts';
import { EVENT_VERSION, type RegisterEvent, type TaskFields } from '../../register/events.ts';
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
    assert.equal(result.stdout.at(-1), 'TEAMS app 1 active, overdue 0 · ops 0 active, overdue 0 · web 1 active, overdue 0 · ui 0 active, overdue 0');
    assert.deepEqual((await kit.run(['stats', '--tree', '--session', 'lead'])).stdout, result.stdout);
    const refused = await kit.run(['stats', '--tree', '--session', 'alpha']);
    assert.deepEqual(refused, { code: EXIT.refused, stdout: ["REFUSED --tree is for the team's lead (app/lead); app/alpha reads its own team's tasks without it"], stderr: [] });
  });
});

const FIELDS: TaskFields = { title: 'Ship it', description: null, owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], noGoal: false, week: null, after: [], size: null, type: null, critical: false, pin: null };

function create(id: string, at: string): RegisterEvent {
  return { v: EVENT_VERSION, type: 'create', id, at, by: 'lead', task: FIELDS };
}

function teamOf(name: string, events: readonly RegisterEvent[]): StatsTeam {
  return { team: name, lead: 'lead', events };
}

describe('statsLines', () => {
  it("names each person's team in a tree, and each split day a task moved to another team", () => {
    const created = create('T1', '2030-01-05T10:00:00.000Z');
    const moved: RegisterEvent = { v: EVENT_VERSION, type: 'moved', id: 'T1', at: '2030-01-06T10:00:00.000Z', by: 'lead', to: 'web' };
    const done: RegisterEvent = { v: EVENT_VERSION, type: 'status', id: 'T1', at: '2030-01-08T10:00:00.000Z', by: 'alpha', status: 'done', note: 'n', evidence: null, skill: null };
    const stats = registerStats({ teams: [teamOf('app', [created, moved]), teamOf('web', [created, done])], range: '7d', now: new Date('2030-01-10T10:00:00.000Z'), zone: testZone('UTC'), ownerMarker: 'owner' });
    const lines = statsLines({ stats, health: registerHealth(stats) }, 'app', ['app', 'web']);
    assert.equal(lines[0], 'STATS app, 7 d: 01-04 to 01-10 (tree: app, web)');
    assert.equal(lines[8], 'PEOPLE web/alpha 1');
    assert.equal(lines[9], 'TEAMS app 0 active, overdue 0 · web 0 active, overdue 0');
    assert.equal(lines[10], 'SPLIT 01-06 1 task(s) moved app -> web: the chart of app before it lacks them');
    assert.equal(lines.length, 11);
  });
});
