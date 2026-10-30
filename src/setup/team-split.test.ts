import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { parseConfig } from '../config/parse.ts';
import { Roster } from '../config/roster.ts';
import { TeamTree, teamNodeOf } from '../config/tree.ts';
import type { JsonRecord } from '../core/guards.ts';
import type { Task } from '../register/fold.ts';
import { testTask } from '../testing/task.ts';
import { configRecordOf, teamNodeOfSpec, teamSpecOf, type Checked, type TeamSpec } from './team-create.ts';
import { planTeamSplit, trimmedParentOf, type SplitParent, type SplitPlan } from './team-split.ts';

/**
 * Team `app`: `dave` reviews security and leads `alpha`, `bravo` leads `carol` and `erin`, `alpha` has its own name
 * and `carol` a launch block. The split moves `alpha` (the child's lead), `bravo` and `carol` into `web`.
 */
const RECORD: JsonRecord = {
  sessions: ['lead', 'alpha', 'bravo', 'carol', 'dave', 'erin'],
  roles: { lead: 'lead', securityReviewer: 'dave' },
  names: { alpha: 'alfa' },
  leads: { bravo: ['carol', 'erin'], dave: ['alpha'] },
  launch: { carol: { model: 'opus' } },
  timeZone: 'Asia/Jerusalem',
};

function valueOf<T>(checked: Checked<T>): T {
  assert.ok(checked.ok, checked.ok ? '' : checked.problem);
  return checked.value;
}

function problemOf<T>(checked: Checked<T>): string {
  assert.ok(!checked.ok, 'expected a problem');
  return checked.problem;
}

/** Team `app`'s folders. */
const PATHS = { home: resolve('kit', 'teams', 'app'), state: resolve('kit', 'teams', 'app', 'state') };

/** The coordinator every child of `app` shares with it when `app` leaves its own to the defaults. */
const SHARED_COORDINATOR = { dir: join(PATHS.state, 'deploys') };

function parentOf(record: JsonRecord = RECORD, configRecord: JsonRecord = record, current: JsonRecord = record): SplitParent {
  const { config, issues } = parseConfig(configRecord);
  assert.deepEqual(issues, [], 'the parent config must be valid');
  return { team: 'app', config, record, current, paths: PATHS, roster: new Roster(config, 'app') };
}

function treeOf(parent: SplitParent, ...others: ReturnType<typeof teamNodeOfSpec>[]): TeamTree {
  return new TeamTree([teamNodeOf(parent.team, parent.config, parent.roster), ...others]);
}

function specOf(sessions: string, lead = 'alpha', team = 'web'): TeamSpec {
  return valueOf(teamSpecOf(team, sessions, lead, 'app'));
}

function tasksOf(...tasks: Task[]): Map<string, Task> {
  return new Map(tasks.map((task) => [task.id, task]));
}

function plan(tasks: ReadonlyMap<string, Task> = new Map(), parent = parentOf(), spec = specOf('bravo,carol')): Checked<SplitPlan> {
  return planTeamSplit(parent, spec, treeOf(parent), tasks);
}

describe('planTeamSplit', () => {
  it('writes the child config with the moved sessions as they were and the parent holding the roles it lacks', () => {
    const spec = specOf('bravo,carol');
    assert.deepEqual(valueOf(plan(new Map(), parentOf(), spec)).config, {
      ...configRecordOf(spec),
      timeZone: 'Asia/Jerusalem',
      delivery: SHARED_COORDINATOR,
      names: { alpha: 'alfa', bravo: 'app-bravo', carol: 'app-carol' },
      roles: { lead: 'alpha', securityReviewer: 'app/dave' },
      leads: { bravo: ['carol'] },
      launch: { carol: { model: 'opus' } },
    });
  });

  it('keeps a role the parent leaves to a team above as that team holds it, and adds only the shared coordinator', () => {
    const record: JsonRecord = { team: { id: 'app', parent: 'org' }, sessions: ['lead', 'alpha', 'bravo'], roles: { lead: 'lead', deliveryOwner: 'org/po' } };
    const parent = parentOf(record);
    const org = teamNodeOfSpec({ team: 'org', lead: 'lead', sessions: ['lead', 'po'], parent: undefined });
    const holder = { ...org, roles: { lead: 'lead', deliveryOwner: 'po' } };
    const spec = specOf('bravo');
    const { config } = valueOf(planTeamSplit(parent, spec, treeOf(parent, holder), new Map()));
    assert.deepEqual(config, {
      ...configRecordOf(spec),
      delivery: SHARED_COORDINATOR,
      names: { alpha: 'app-alpha', bravo: 'app-bravo' },
      roles: { lead: 'alpha', deliveryOwner: 'org/po' },
    });
  });

  it("copies the parent's settings blocks as it holds them, so the child runs as its parent did", () => {
    const record: JsonRecord = {
      ...RECORD,
      refresh: { contextTokens: 130000 },
      readonlyShell: { enabled: false },
      wake: { enabled: false },
    };
    const { config } = valueOf(plan(new Map(), parentOf(record)));
    assert.deepEqual(config['refresh'], { contextTokens: 130000 });
    assert.deepEqual(config['readonlyShell'], { enabled: false });
    assert.deepEqual(config['wake'], { enabled: false });
  });

  it("takes the copied blocks and launch blocks from the config in this teamrig's format, not the older file", () => {
    const current: JsonRecord = { ...RECORD, refresh: { contextTokens: 90000 }, launch: { carol: { model: 'sonnet' } } };
    const { config } = valueOf(plan(new Map(), parentOf({ ...RECORD, refresh: { contextTokens: 130000 } }, RECORD, current)));
    assert.deepEqual(config['refresh'], { contextTokens: 90000 });
    assert.deepEqual(config['launch'], { carol: { model: 'sonnet' } });
  });

  it("shares the parent's coordinator folder, host lock and main checkouts, each relative path made absolute to the parent", () => {
    const record: JsonRecord = {
      ...RECORD,
      delivery: { dir: 'deploys', queue: { lockPath: 'heavy.lock' }, repos: { app: { mainCheckout: 'app', deploysOnPush: [] } } },
      budget: { statusSnapshotDir: 'status' },
    };
    const { config } = valueOf(plan(new Map(), parentOf(record)));
    assert.deepEqual(config['delivery'], {
      dir: join(PATHS.home, 'deploys'),
      queue: { lockPath: join(PATHS.home, 'heavy.lock') },
      repos: { app: { mainCheckout: join(PATHS.home, 'app'), deploysOnPush: [] } },
    });
    assert.deepEqual(config['budget'], { statusSnapshotDir: join(PATHS.home, 'status') });
  });

  it('keeps an absolute coordinator folder and host lock as the parent wrote them', () => {
    const dir = resolve('shared', 'deploys');
    const lockPath = resolve('shared', 'heavy.lock');
    const { config } = valueOf(plan(new Map(), parentOf({ ...RECORD, delivery: { dir, queue: { lockPath } } })));
    assert.deepEqual(config['delivery'], { dir, queue: { lockPath } });
  });

  it("gives the child the moved sessions' budget shares and idle keep-open entries, and trims them from the parent", () => {
    const record: JsonRecord = {
      ...RECORD,
      budget: { sessions: { bravo: { share: 2 }, dave: { share: 3 } } },
      open: { idle: { mode: 'on', keepOpen: ['carol', 'erin'] } },
    };
    const split = valueOf(plan(new Map(), parentOf(record)));
    assert.deepEqual(split.config['budget'], { sessions: { bravo: { share: 2 } } });
    assert.deepEqual(split.config['open'], { idle: { mode: 'on', keepOpen: ['carol'] } });
    assert.deepEqual(split.trim.keys, ['names.alpha', 'leads.bravo', 'budget.sessions.bravo', 'launch.carol', 'open.idle.keepOpen[carol]']);
    const trimmed = trimmedParentOf(record, new Set(['alpha', 'bravo', 'carol']));
    assert.deepEqual(trimmed['budget'], { sessions: { dave: { share: 3 } } });
    assert.deepEqual(trimmed['open'], { idle: { mode: 'on', keepOpen: ['erin'] } });
  });

  it("leaves the budget keys of the account's week out of the child, which reads them from the parent", () => {
    const budget: JsonRecord = {
      enabled: true,
      account: 'work',
      weeklyLimitW: 9_000_000,
      subagentWeight: 2,
      extraWPerUsd: 40_000,
      reset: { weekday: 'wed', timeUtc: '01:00' },
      targetPct: 90,
      sessions: { bravo: { share: 2 }, dave: { share: 3 } },
    };
    const split = valueOf(plan(new Map(), parentOf({ ...RECORD, budget })));
    assert.deepEqual(split.config['budget'], { targetPct: 90, sessions: { bravo: { share: 2 } } });
  });

  it("gives the child no budget block when the parent's holds only keys of the account's week", () => {
    const split = valueOf(plan(new Map(), parentOf({ ...RECORD, budget: { enabled: true, weeklyLimitW: 9_000_000 } })));
    assert.equal(split.config['budget'], undefined);
  });

  it("lists the keys the child starts without: the parent's own GitHub import and folders, and keys this teamrig does not know", () => {
    const record: JsonRecord = { ...RECORD, github: { repos: ['org/app'] }, paths: { inbox: 'mail' } };
    const split = valueOf(plan(new Map(), parentOf(record, record, { ...record, future: { kept: true } })));
    assert.deepEqual(split.leftOut, ['github', 'paths', 'future']);
    assert.equal(split.config['github'], undefined);
    assert.equal(split.config['paths'], undefined);
    assert.equal(split.config['future'], undefined);
    assert.deepEqual(valueOf(plan()).leftOut, []);
  });

  it('trims the parent of the moved keys and reports the sub-lead lists the border cuts', () => {
    assert.deepEqual(valueOf(plan()).trim, {
      keys: ['names.alpha', 'leads.bravo', 'launch.carol'],
      leftLeads: [{ lead: 'dave', id: 'alpha' }],
      unled: [{ lead: 'bravo', id: 'erin' }],
    });
  });

  it('moves the tasks the moved sessions own and counts the rest', () => {
    const tasks = tasksOf(testTask({ id: 'T1', owner: 'alpha' }), testTask({ id: 'T2', owner: 'lead' }), testTask({ id: 'T3', owner: 'carol' }));
    const split = valueOf(plan(tasks));
    assert.deepEqual(
      split.moving.map((task) => task.id),
      ['T1', 'T3'],
    );
    assert.equal(split.staying, 1);
  });

  it('names a session across the border as <team>/<id>, never the owner marker, an address or one on its own side', () => {
    const tasks = tasksOf(
      testTask({ id: 'T1', owner: 'alpha', source: 'lead', pin: 'lead' }),
      testTask({ id: 'T2', owner: 'lead', source: 'bravo', waits: [{ kind: 'approval', who: 'alpha' }, { kind: 'decision', who: 'owner' }] }),
      testTask({ id: 'T3', owner: 'bravo', source: 'alpha', answer: { verdict: 'approved', by: 'lead', at: '2030-01-07T10:00:00.000Z', note: 'ok' } }),
      testTask({ id: 'T4', owner: 'erin', source: 'org/po', waits: [{ kind: 'decision', who: 'dave' }] }),
    );
    assert.deepEqual(valueOf(plan(tasks)).rewrites, [
      { task: 'T1', field: 'source', from: 'lead', to: 'app/lead', moves: true },
      { task: 'T1', field: 'pin', from: 'lead', to: 'app/lead', moves: true },
      { task: 'T2', field: 'source', from: 'bravo', to: 'web/bravo', moves: false },
      { task: 'T3', field: 'answer', from: 'lead', to: 'app/lead', moves: true },
    ]);
  });

  it("blocks on a staying task's wait for a moved session's decision or approval, and leaves an approval it gave as written", () => {
    const tasks = tasksOf(
      testTask({ id: 'T1', owner: 'lead', waits: [{ kind: 'approval', who: 'bravo' }], answer: { verdict: 'approved', by: 'bravo', at: '2030-01-07T10:00:00.000Z', note: 'ok' } }),
      testTask({ id: 'T2', owner: 'erin', waits: [{ kind: 'decision', who: 'carol' }, { kind: 'decision', who: 'lead' }] }),
    );
    const split = valueOf(plan(tasks));
    assert.deepEqual(split.blockers, [
      { task: 'T1', field: 'approval', from: 'bravo', to: 'web/bravo', moves: false },
      { task: 'T2', field: 'decision', from: 'carol', to: 'web/carol', moves: false },
    ]);
    assert.deepEqual(split.rewrites, []);
  });

  it('lists the after and wait links between a moving task and a staying one of the working set', () => {
    const tasks = tasksOf(
      testTask({ id: 'T1', owner: 'alpha' }),
      testTask({ id: 'T2', owner: 'lead', after: ['T1', 'T9'] }),
      testTask({ id: 'T3', owner: 'bravo', after: ['T1', 'T2'], waits: [{ kind: 'task', id: 'T2' }] }),
    );
    assert.deepEqual(valueOf(plan(tasks)).links, [
      { task: 'T2', on: 'T1', kind: 'after', taskMoves: false },
      { task: 'T3', on: 'T2', kind: 'after', taskMoves: true },
      { task: 'T3', on: 'T2', kind: 'waits', taskMoves: true },
    ]);
  });

  it('refuses a session the parent does not have, its lead and a holder of its roles', () => {
    assert.match(problemOf(plan(new Map(), parentOf(), specOf('bravo,zed'))), /^zed is not a session of team app \(sessions: /);
    assert.equal(problemOf(plan(new Map(), parentOf(), specOf('bravo', 'lead'))), "lead leads team app, which keeps its lead; a split moves other sessions");
    assert.equal(problemOf(plan(new Map(), parentOf(), specOf('dave'))), "dave is team app's securityReviewer; give that role to a session that stays, then split");
  });

  it('refuses a child id another team has, and a parent the tree lacks', () => {
    const parent = parentOf();
    const web = teamNodeOfSpec({ team: 'web', lead: 'lead', sessions: ['lead', 'dev'], parent: undefined });
    assert.equal(problemOf(planTeamSplit(parent, specOf('bravo'), treeOf(parent, web), new Map())), 'team web exists already; a split makes a new team');
    assert.equal(problemOf(planTeamSplit(parent, specOf('bravo'), new TeamTree([]), new Map())), 'team app is not in the tree of teams read from the kit home');
  });

  it('refuses a child below the deepest level, but not for a problem the tree had before', () => {
    const parent = parentOf({ ...RECORD, team: { id: 'app', parent: 'mid' } });
    const root = teamNodeOfSpec({ team: 'root', lead: 'lead', sessions: ['lead', 'dev'], parent: undefined });
    const mid = teamNodeOfSpec({ team: 'mid', lead: 'lead', sessions: ['lead', 'dev'], parent: 'root' });
    assert.match(problemOf(planTeamSplit(parent, specOf('bravo'), treeOf(parent, root, mid), new Map())), /^team web cannot join that tree: team web is at level 4 of its tree/);
    const stray = teamNodeOfSpec({ team: 'stray', lead: 'lead', sessions: ['lead', 'dev'], parent: 'gone' });
    assert.ok(planTeamSplit(parentOf(), specOf('bravo'), treeOf(parentOf(), stray), new Map()).ok);
  });

  it('refuses a launch block the child config could not hold as written', () => {
    const record: JsonRecord = { ...RECORD, launch: { carol: { model: 42 } } };
    assert.match(problemOf(plan(new Map(), parentOf(record, RECORD))), /^team web's config would break its schema at launch\.carol/);
  });
});

describe('trimmedParentOf', () => {
  it("drops the moved sessions from the sessions, names, launch blocks and sub-leads' lists, every other key as written", () => {
    const record = {
      version: 1,
      sessions: ['lead', 'alpha', 'bravo', 'carol', 'dave'],
      names: { alpha: 'scout', carol: 'cee' },
      launch: { bravo: { effort: 'high' }, carol: { effort: 'low' } },
      leads: { alpha: ['dave'], carol: ['bravo'], dave: ['erin', 'alpha'] },
      roles: { lead: 'lead' },
      future: { kept: true },
    };
    assert.deepEqual(trimmedParentOf(record, new Set(['alpha', 'bravo'])), {
      version: 1,
      sessions: ['lead', 'carol', 'dave'],
      names: { carol: 'cee' },
      launch: { carol: { effort: 'low' } },
      leads: { dave: ['erin'] },
      roles: { lead: 'lead' },
      future: { kept: true },
    });
  });

  it('adds no key the config lacks, and leaves a damaged list for the config check to name', () => {
    assert.deepEqual(trimmedParentOf({ sessions: ['lead', 'alpha'] }, new Set(['alpha'])), { sessions: ['lead'] });
    assert.deepEqual(trimmedParentOf({ sessions: 'lead', leads: { carol: 'alpha' } }, new Set(['alpha'])), { sessions: 'lead', leads: { carol: 'alpha' } });
  });
});
