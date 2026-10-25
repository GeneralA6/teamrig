import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatConfig } from '../config/load.ts';
import { readEvents } from '../register/snapshot.ts';
import { CONFIG_PATH, EVENTS_PATH } from '../testing/cli-harness.ts';
import { teamConfigOf, teamEventsOf, teamInboxOf, treeHarness } from '../testing/team-tree.ts';
import type { CliHarness } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const WEB = { TEAMRIG_TEAM: 'web' };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };

describe('teamrig add --team', () => {
  it('hands a child team a task from its parent lead, written in the child register only', async () => {
    const kit = await treeHarness();
    const result = await kit.run(['add', '--team', 'web', '--title', 'Ship login', '--description', 'what and why', '--priority', 'p2', '--session', 'lead']);
    assert.deepEqual(result, { code: EXIT.ok, stdout: ['ADDED web/T1 open, p2, owner lead, from app/lead | Ship login'], stderr: ['NOTE web/lead has an inbox line: T1 is yours (p2): Ship login'] });
    assert.equal(kit.files.get(teamInboxOf('web', 'lead')), '- 2030-01-08 10:00 app/lead: T1 is yours (p2): Ship login\n');
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), undefined);
    const [event] = readEvents(kit.files.get(teamEventsOf('web')) ?? '').events;
    assert.deepEqual([event?.by, event?.type], ['app/lead', 'create']);
    assert.equal(kit.files.get(EVENTS_PATH), undefined);
    const queue = await kit.run(['list', '--session', 'lead', '--all'], { env: WEB });
    assert.deepEqual(queue.stdout, ['T1 open, p2, owner lead, from app/lead | Ship login']);
    const started = await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'lead'], { env: WEB });
    assert.equal(started.code, EXIT.ok);
    const reprioritized = await kit.run(['update', 'T1', '--priority', 'p1', '--session', 'lead'], { env: WEB });
    assert.equal(reprioritized.code, EXIT.ok);
  });

  it("lets a sub-team lead hand its own child team a task, by the lead's name", async () => {
    const kit = await treeHarness();
    const result = await kit.run(['add', '--team', 'ui', '--title', 'New icons', '--description', 'what and why', '--priority', 'p1', '--session', 'web-lead'], { env: WEB });
    assert.deepEqual(result.stdout, ['ADDED ui/T1 open, p1, owner lead, from web/lead | New icons']);
    assert.equal(kit.files.get(teamInboxOf('ui', 'lead')), '- 2030-01-08 10:00 web/lead: T1 is yours (p1): New icons\n');
  });

  it("carries the description into the child team's task, and needs one there too", async () => {
    const kit = await treeHarness();
    const bare = await kit.run(['add', '--team', 'web', '--title', 'Ship login', '--priority', 'p2', '--session', 'lead']);
    assert.deepEqual(bare.stdout, ['REFUSED add needs --description "<what and why, in plain words>"']);
    await kit.run(['add', '--team', 'web', '--title', 'Ship login', '--description', 'Users ask for it.', '--priority', 'p2', '--session', 'lead']);
    const [event] = readEvents(kit.files.get(teamEventsOf('web')) ?? '').events;
    assert.equal(event?.type === 'create' ? event.task.description : undefined, 'Users ask for it.');
  });

  it('lets any session of the tree ask a session of another team, by name, its lead getting a copy line to act on', async () => {
    const kit = await treeHarness();
    const result = await kit.run(['add', '--team', 'web', '--owner', 'web-front', '--title', 'Ship login', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    const copy = 'T1 went to front (p2): Ship login; reorder or reassign it: teamrig update T1 --priority|--after|--owner';
    assert.deepEqual(result, {
      code: EXIT.ok,
      stdout: ['ADDED web/T1 open, p2, owner front, from app/alpha | Ship login'],
      stderr: ['NOTE web/front has an inbox line: T1 is yours (p2): Ship login', `NOTE web/lead has an inbox line: ${copy}`],
    });
    assert.equal(kit.files.get(teamInboxOf('web', 'front')), '- 2030-01-08 10:00 app/alpha: T1 is yours (p2): Ship login\n');
    assert.equal(kit.files.get(teamInboxOf('web', 'lead')), `- 2030-01-08 10:00 app/alpha: ${copy}\n`);
    const reassigned = await kit.run(['update', 'T1', '--owner', 'back', '--session', 'lead'], { env: WEB });
    assert.equal(reassigned.code, EXIT.ok);
  });

  it('reaches a sibling team and the root above, and is a plain add for the caller\'s own team', async () => {
    const kit = await treeHarness();
    const runs: readonly [readonly string[], Record<string, string>, string][] = [
      [['--title', 'New icons', '--team', 'ui', '--owner', 'pixel', '--session', 'run'], { TEAMRIG_TEAM: 'ops' }, 'ADDED ui/T1 open, p2, owner pixel, from ops/run | New icons'],
      [['--title', 'Ship login', '--team', 'app', '--session', 'pixel'], { TEAMRIG_TEAM: 'ui' }, 'ADDED app/T2 open, p2, owner lead, from ui/pixel | Ship login'],
      [['--title', 'Own work', '--team', 'app', '--owner', 'bravo', '--session', 'alpha'], {}, 'ADDED T3 open, p2, owner bravo, from alpha | Own work'],
    ];
    for (const [extra, env, line] of runs) {
      const result = await kit.run(['add', '--description', 'what and why', '--priority', 'p2', ...extra], { env });
      assert.deepEqual([result.code, result.stdout], [EXIT.ok, [line]]);
    }
  });

  it('refuses a team outside the tree, an unknown team, an owner off its roster and --source, writing nothing', async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('solo'), formatConfig({ configVersion: 1, team: { id: 'solo' }, sessions: ['lead', 'one'], roles: { lead: 'lead' } }));
    const refusals: [readonly string[], RegExp][] = [
      [['--team', 'solo'], /^REFUSED team solo is not in app's team tree, so app\/alpha may not add its tasks$/],
      [['--team', 'blog'], /^REFUSED no team blog with a config in this kit home$/],
      [['--team', 'web', '--owner', 'pixel'], /^REFUSED team web: pixel is not a session on this team \(sessions: /],
    ];
    for (const [extra, line] of refusals) {
      const result = await kit.run(['add', '--title', 'Ship login', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha', ...extra]);
      assert.equal(result.code, EXIT.refused);
      assert.match(result.stdout[0] ?? '', line);
    }
    const sourced = await kit.run(['add', '--team', 'web', '--title', 'x', '--description', 'what and why', '--priority', 'p2', '--source', 'front', '--session', 'lead']);
    assert.equal(sourced.code, EXIT.usage);
    assert.match(sourced.stderr[0] ?? '', /^--team adds the task from you: it takes no --source/);
    for (const team of ['app', 'web', 'ui', 'solo']) {
      assert.equal(kit.files.get(teamEventsOf(team)), undefined, team);
    }
  });
});

/**
 * The tree with one task in `app` (overdue, in the week plan), one handed to `web` and one in `ui`, added in that
 * order, so the tree's one numbering (T1139) makes them app/T1, web/T2 and ui/T3.
 */
async function seeded(): Promise<CliHarness> {
  const kit = await treeHarness();
  const runs: readonly [readonly string[], Record<string, string>][] = [
    [['add', '--title', 'Root task', '--description', 'what and why', '--priority', 'p1', '--owner', 'alpha', '--week', '2030-01-07', '--due', '2030-01-07', '--session', 'lead'], {}],
    [['add', '--team', 'web', '--title', 'Ship login', '--description', 'what and why', '--priority', 'p2', '--week', '2030-01-07', '--session', 'lead'], {}],
    [['add', '--title', 'Icons', '--description', 'what and why', '--priority', 'p2', '--owner', 'pixel', '--session', 'lead'], { TEAMRIG_TEAM: 'ui' }],
  ];
  for (const [argv, env] of runs) {
    assert.equal((await kit.run(argv, { env })).code, EXIT.ok);
  }
  return kit;
}

function filesOf(kit: CliHarness): [string, string | undefined][] {
  return kit.files.paths().map((path) => [path, kit.files.get(path)]);
}

describe('teamrig list|check|plan --tree', () => {
  it("lists the lead's team and every team under it, depth first, ids naming the team, writing nothing", async () => {
    const kit = await seeded();
    const before = filesOf(kit);
    const result = await kit.run(['list', '--tree', '--all'], AS_LEAD);
    assert.deepEqual(result, {
      code: EXIT.ok,
      stdout: [
        'app/T1 open, p1, owner alpha, due 01-07, week 01-07, from lead | Root task',
        'web/T2 open, p2, owner lead, week 01-07, from app/lead | Ship login · ahead: in week 01-07',
        'ui/T3 open, p2, owner pixel, from lead | Icons',
      ],
      stderr: [],
    });
    const fromParent = await kit.run(['list', '--tree', '--all', '--source', 'app/lead'], AS_LEAD);
    assert.deepEqual(fromParent.stdout, ['web/T2 open, p2, owner lead, week 01-07, from app/lead | Ship login']);
    const byName = await kit.run(['list', '--tree', '--all', '--source', 'app-lead'], AS_LEAD);
    assert.deepEqual(byName.stdout, ['app/T1 open, p1, owner alpha, due 01-07, week 01-07, from lead | Root task']);
    const sub = await kit.run(['list', '--tree', '--all'], { env: { ...WEB, TEAMRIG_SESSION: 'lead' } });
    assert.deepEqual(sub.stdout.map((line) => line.split(' ')[0]), ['web/T2', 'ui/T3']);
    const short = await kit.run(['list', '--tree'], AS_LEAD);
    assert.deepEqual(short.stdout, [
      'LIST 3 task(s) of 3 owners (short rows; --all for every field)',
      '  app/alpha 1: 1 open',
      '  ui/pixel 1: 1 open',
      '  web/lead 1: 1 open',
      'app/T1 open, p1, owner alpha, due 01-07 | Root task',
      'web/T2 open, p2, owner lead | Ship login · ahead: in week 01-07',
      'ui/T3 open, p2, owner pixel | Icons',
    ]);
    assert.deepEqual(filesOf(kit), before);
  });

  it('checks every team against the lead week, then the shared skills folder once', async () => {
    const kit = await seeded();
    const result = await kit.run(['check', '--tree', '--session', 'lead', '--all']);
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(
      result.stdout.filter((line) => !line.startsWith('SKILLS')),
      [
        'CHECK app: 1 flag(s), week 2030-01-07',
        'OVERDUE (due 01-07) app/T1 open, p1, owner alpha, due 01-07, week 01-07, from lead | Root task',
        'CHECK ops: 0 flag(s), week 2030-01-07',
        'CHECK web: 0 flag(s), week 2030-01-07',
        'CHECK ui: 0 flag(s), week 2030-01-07',
      ],
    );
    assert.equal(result.stdout.filter((line) => line.startsWith('SKILLS')).length, 1);
    const short = await kit.run(['check', '--tree', '--session', 'lead']);
    assert.deepEqual(short.stdout.slice(0, 3), [
      'CHECK 1 flag(s) in 4 team(s), week 2030-01-07 (short form; --all for every flag in full)',
      'OVERDUE 1 (due 01-07)',
      '  app/T1 open, p1, owner alpha, due 01-07 | Root task',
    ]);
    assert.match(short.stdout[3] ?? '', /^SKILLS \d+ flag\(s\) in /);
  });

  it('plans one section per team for the lead week', async () => {
    const kit = await seeded();
    const result = await kit.run(['plan', '--tree', '--session', 'lead']);
    const headings = result.stdout.join('\n').split('\n').filter((line) => line.startsWith('# '));
    assert.deepEqual(headings, ['# Week plan 2030-01-07, team app', '# Week plan 2030-01-07, team ops', '# Week plan 2030-01-07, team web', '# Week plan 2030-01-07, team ui']);
    assert.match(result.stdout.join('\n'), /- \[ \] \*\*web\/T2\*\* Ship login \(lead · from app\/lead\)/);
  });

  it('is for the lead only, named by --session or $TEAMRIG_SESSION', async () => {
    const kit = await seeded();
    const member = await kit.run(['check', '--tree', '--session', 'alpha']);
    assert.deepEqual(member.stdout, ["REFUSED --tree is for the team's lead (app/lead); app/alpha reads its own team's tasks without it"]);
    const noTree = await kit.run(['list', '--tree'], { env: { TEAMRIG_SESSION: 'alpha' } });
    assert.equal(noTree.code, EXIT.refused);
    const memberFlag = await kit.run(['list', '--tree', '--session', 'alpha'], AS_LEAD);
    assert.equal(memberFlag.code, EXIT.refused);
  });

  it('reads --session as the caller with --tree, so a tab without $TEAMRIG_SESSION lists its tree', async () => {
    const kit = await seeded();
    const byFlag = await kit.run(['list', '--tree', '--session', 'lead']);
    const byEnv = await kit.run(['list', '--tree'], AS_LEAD);
    assert.equal(byFlag.code, EXIT.ok);
    assert.deepEqual(byFlag.stdout, byEnv.stdout);
    assert.ok(byFlag.stdout.some((line) => line.startsWith('web/T2 ')));
    const own = await kit.run(['list', '--session', 'lead']);
    assert.ok(own.stdout.every((line) => !line.startsWith('web/')));
  });
});

describe('teamrig set: a task another team asked for ends (T509, T1141)', () => {
  const done = (id: string, evidence: string, note = 'shipped', session = 'lead'): string[] =>
    ['set', id, '--status', 'done', '--note', note, '--evidence', evidence, '--skill', 'none', '--followups', 'none', '--session', session];

  it("tells the parent's lead in its own inbox, under the child team's name, once", async () => {
    const kit = await seeded();
    const result = await kit.run(done('T2', 'PR #12 merged'), { env: WEB });
    assert.equal(result.code, EXIT.ok);
    assert.ok(result.stderr.includes('NOTE app/lead has an inbox line: web/T2 done: Ship login | evidence: PR #12 merged'), result.stderr.join('\n'));
    const told = '- 2030-01-08 10:00 web/lead: web/T2 done: Ship login | evidence: PR #12 merged\n';
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), told);
    const again = await kit.run(done('T2', 'PR #12 merged', 'merged twice'), { env: WEB });
    assert.equal(again.code, EXIT.ok);
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), told);
  });

  it('names a dropped task with its note', async () => {
    const kit = await seeded();
    const result = await kit.run(['set', 'T2', '--status', 'dropped', '--note', 'not needed', '--session', 'lead'], { env: WEB });
    assert.equal(result.code, EXIT.ok);
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), '- 2030-01-08 10:00 web/lead: web/T2 dropped: Ship login | note: not needed\n');
  });

  it("tells a sub-team's lead of its child team's task, and no team above it", async () => {
    const kit = await treeHarness();
    await kit.run(['add', '--team', 'ui', '--title', 'New icons', '--description', 'what and why', '--priority', 'p1', '--session', 'lead'], { env: WEB });
    const result = await kit.run(done('T1', 'icons in the build'), { env: { TEAMRIG_TEAM: 'ui' } });
    assert.equal(result.code, EXIT.ok);
    assert.equal(kit.files.get(teamInboxOf('web', 'lead')), '- 2030-01-08 10:00 ui/lead: ui/T1 done: New icons | evidence: icons in the build\n');
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), undefined);
  });

  it("tells no one when a team's own task ends, on a child team or the root", async () => {
    const kit = await seeded();
    const before = [kit.files.get(teamInboxOf('web', 'lead')), kit.files.get(teamInboxOf('app', 'lead'))];
    const child = await kit.run(done('T3', 'icons drawn', 'shipped', 'pixel'), { env: { TEAMRIG_TEAM: 'ui' } });
    const root = await kit.run(done('T1', 'root shipped', 'shipped', 'alpha'));
    assert.deepEqual([child.code, root.code], [EXIT.ok, EXIT.ok]);
    assert.deepEqual([kit.files.get(teamInboxOf('web', 'lead')), kit.files.get(teamInboxOf('app', 'lead'))], before);
  });

  it("scans the line with the parent team's secret patterns too, and keeps the task when it cannot go", async () => {
    const kit = await treeHarness({ register: { secretPatterns: ['hush-[0-9]+'] } });
    await kit.run(['add', '--team', 'web', '--title', 'Ship login', '--description', 'what and why', '--priority', 'p2', '--session', 'lead']);
    const result = await kit.run(done('T1', 'rotated hush-1234'), { env: WEB });
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout[0] ?? '', /^SET T1 done/);
    assert.deepEqual(result.stderr.filter((line) => line.startsWith('WARN')).map((line) => line.split(':')[0]), ['WARN app/lead was not told that web/T1 ended']);
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), undefined);
  });

  it('names a parent with no config instead of throwing, the task set either way', async () => {
    const kit = await treeHarness();
    await kit.run(['add', '--team', 'ui', '--title', 'New icons', '--description', 'what and why', '--priority', 'p1', '--session', 'lead'], { env: WEB });
    assert.equal(await kit.files.remove(teamConfigOf('web')), true);
    const result = await kit.run(done('T1', 'icons in the build'), { env: { TEAMRIG_TEAM: 'ui' } });
    assert.equal(result.code, EXIT.ok);
    assert.ok(result.stderr.includes('WARN web/lead was not told that ui/T1 ended: team web has no config in this kit home'), result.stderr.join('\n'));
  });

  it('tells the session that asked, on any team of the tree, not its lead', async () => {
    const kit = await treeHarness();
    await kit.run(['add', '--team', 'web', '--owner', 'front', '--title', 'Ship login', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    await kit.run(['add', '--team', 'ui', '--owner', 'pixel', '--title', 'New icons', '--description', 'what and why', '--priority', 'p2', '--session', 'run'], { env: { TEAMRIG_TEAM: 'ops' } });
    assert.equal((await kit.run(done('T1', 'PR #12 merged', 'shipped', 'front'), { env: WEB })).code, EXIT.ok);
    assert.equal((await kit.run(done('T2', 'icons in the build', 'shipped', 'pixel'), { env: { TEAMRIG_TEAM: 'ui' } })).code, EXIT.ok);
    assert.equal(kit.files.get(teamInboxOf('app', 'alpha')), '- 2030-01-08 10:00 web/front: web/T1 done: Ship login | evidence: PR #12 merged\n');
    assert.equal(kit.files.get(teamInboxOf('ops', 'run')), '- 2030-01-08 10:00 ui/pixel: ui/T2 done: New icons | evidence: icons in the build\n');
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), undefined);
  });

  it("tells the asker's team lead when the asker has left that team", async () => {
    const kit = await treeHarness();
    await kit.run(['add', '--team', 'web', '--title', 'Ship login', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    await kit.files.write(CONFIG_PATH, formatConfig({ configVersion: 1, team: { id: 'app' }, sessions: ['lead', 'bravo'], roles: { lead: 'lead' } }));
    assert.equal((await kit.run(done('T1', 'PR #12 merged'), { env: WEB })).code, EXIT.ok);
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), '- 2030-01-08 10:00 web/lead: web/T1 done: Ship login | evidence: PR #12 merged\n');
  });
});
