import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import type { Files } from '../core/files.ts';
import type { JsonRecord } from '../core/guards.ts';
import { readEvents } from '../register/snapshot.ts';
import { TEST_OWNER_CARD, TEST_OWNER_CARD_FLAGS } from '../testing/card.ts';
import { bash, CONFIG_PATH, EVENTS_PATH, reasonOf } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { SUB_TEAMS, teamConfigOf, teamEventsOf, teamHomeOf, teamInboxOf, treeHarness } from '../testing/team-tree.ts';
import type { CliHarness } from '../testing/cli-harness.ts';
import { WakeAsks, type WakeAsk } from '../wake/asks.ts';
import { EXIT } from './runtime.ts';

/** A team's wake asks folder, where its sessions' tabs' wake checks read them. */
function wakeAsksOf(team: string): string {
  return join(teamHomeOf(team), 'state', 'wake-asks');
}

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
    await kit.holdSecretDeny();
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

describe('teamrig update <team>/<id>: the root lead notes a task below (T1018)', () => {
  it("writes the note in that team's register only, by the root lead's address, on a child's and a grandchild's task", async () => {
    const kit = await seeded();
    const appEvents = kit.files.get(EVENTS_PATH);
    for (const [label, team] of [['web/T2', 'web'], ['ui/T3', 'ui']] as const) {
      const result = await kit.run(['update', label, '--note', 'human decided: ship it', '--session', 'lead']);
      assert.equal(result.code, EXIT.ok, label);
      assert.match(result.stdout[0] ?? '', new RegExp(`^UPDATED ${label} open, `), label);
      const event = readEvents(kit.files.get(teamEventsOf(team)) ?? '').events.at(-1);
      assert.deepEqual([event?.by, event?.type, event?.type === 'update' ? event.note : undefined], ['app/lead', 'update', 'human decided: ship it'], label);
    }
    assert.equal(kit.files.get(EVENTS_PATH), appEvents);
  });

  it('refuses all but the root lead, a root team, an unknown team, its own team, a field and no note, writing nothing', async () => {
    const kit = await seeded();
    const before = filesOf(kit);
    const refusals: [readonly string[], Record<string, string>, string][] = [
      [['web/T2', '--session', 'alpha'], {}, "REFUSED only app/lead, who asks the owner team web's decisions, notes its tasks from another team; app/alpha may not"],
      [['ui/T3', '--session', 'lead'], WEB, "REFUSED only app/lead, who asks the owner team ui's decisions, notes its tasks from another team; web/lead may not"],
      [['app/T1', '--session', 'lead'], WEB, 'REFUSED team app has no parent team, so only its own sessions note its tasks'],
      [['blog/T2', '--session', 'lead'], {}, 'REFUSED no team blog with a config in this kit home'],
    ];
    for (const [extra, env, line] of refusals) {
      const result = await kit.run(['update', ...extra, '--note', 'x'], { env });
      assert.deepEqual([result.code, result.stdout], [EXIT.refused, [line]]);
    }
    const usages: [readonly string[], RegExp][] = [
      [['app/T1', '--note', 'x'], /^app\/T1 is a task of your own team: update T1/],
      [['web/T2', '--priority', 'p1', '--note', 'x'], /^update web\/T2 adds a --note, a --later or a --decided to another team's task: it takes no --priority/],
      [['web/T2', '--pin'], /^update web\/T2 adds a --note, a --later or a --decided to another team's task: it takes no --pin/],
      [['web/T2', '--later', '2030-01-09', '--due', '2030-01-10', '--note', 'x'], /^update web\/T2 adds a --note, a --later or a --decided to another team's task: it takes no --due/],
      [['web/T2', '--decided', '--later', '2030-01-09', '--note', 'x'], /^--decided records the owner's answer with a --note alone: it takes no --later/],
      [['web/T2', '--decided'], /^--note is required/],
      [['web/T2'], /^--note is required/],
      [['web/T2/x', '--note', 'x'], /is not a task id like T12, or web\/T12/],
    ];
    for (const [extra, message] of usages) {
      const result = await kit.run(['update', ...extra, '--session', 'lead']);
      assert.equal(result.code, EXIT.usage, extra.join(' '));
      assert.match(result.stderr[0] ?? '', message);
    }
    assert.deepEqual(filesOf(kit), before);
  });
});

describe('teamrig update <team>/<id> --later: the root lead puts a card below off (T1295)', () => {
  it("writes the Later in that team's register by the root lead's address, and refuses a task waiting on no owner", async () => {
    const kit = await treeHarness();
    assert.equal((await kit.run(['add', '--title', 'Pick a host', '--description', 'what and why', '--priority', 'p1', '--session', 'lead'], { env: WEB })).code, EXIT.ok);
    const set = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'the cost', ...TEST_OWNER_CARD_FLAGS, '--session', 'lead'], { env: WEB });
    assert.equal(set.code, EXIT.ok, [...set.stdout, ...set.stderr].join('\n'));
    const later = await kit.run(['update', 'web/T1', '--later', '2030-01-09 09:00', '--note', 'human: after the demo', '--session', 'lead']);
    assert.equal(later.code, EXIT.ok, [...later.stdout, ...later.stderr].join('\n'));
    assert.match(later.stdout[0] ?? '', /^UPDATED web\/T1 waiting, /);
    const event = readEvents(kit.files.get(teamEventsOf('web')) ?? '').events.at(-1);
    assert.deepEqual(event?.type === 'update' ? [event.by, event.note, event.waits] : undefined, [
      'app/lead',
      'human: after the demo',
      [
        { kind: 'decision', who: 'owner' },
        { kind: 'time', at: '2030-01-09 09:00' },
      ],
    ]);
    assert.equal((await kit.run(['add', '--title', 'Draw icons', '--description', 'what and why', '--priority', 'p2', '--session', 'lead'], { env: WEB })).code, EXIT.ok);
    const open = await kit.run(['update', 'web/T2', '--later', '2030-01-09', '--note', 'x', '--session', 'lead']);
    assert.deepEqual([open.code, open.stdout], [EXIT.refused, ['REFUSED T2 waits on no decision or approval of owner: only such a card is put off']]);
  });
});

describe('teamrig update <team>/<id> --decided: the root lead records the owner answer to a card below (T1366)', () => {
  it("writes the Decided in that team's register by the root lead's address, and refuses a task waiting on no owner", async () => {
    const kit = await treeHarness();
    assert.equal((await kit.run(['add', '--title', 'Pick a host', '--description', 'what and why', '--priority', 'p1', '--session', 'lead'], { env: WEB })).code, EXIT.ok);
    const set = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'the cost', ...TEST_OWNER_CARD_FLAGS, '--session', 'lead'], { env: WEB });
    assert.equal(set.code, EXIT.ok, [...set.stdout, ...set.stderr].join('\n'));
    const decided = await kit.run(['update', 'web/T1', '--decided', '--note', 'human decided: the cheaper host', '--session', 'lead']);
    assert.equal(decided.code, EXIT.ok, [...decided.stdout, ...decided.stderr].join('\n'));
    assert.match(decided.stdout[0] ?? '', /^UPDATED web\/T1 waiting, /);
    const event = readEvents(kit.files.get(teamEventsOf('web')) ?? '').events.at(-1);
    assert.deepEqual(event?.type === 'update' ? [event.by, event.note, event.waits, event.decided] : undefined, ['app/lead', 'human decided: the cheaper host', [], true]);
    assert.equal((await kit.run(['add', '--title', 'Draw icons', '--description', 'what and why', '--priority', 'p2', '--session', 'lead'], { env: WEB })).code, EXIT.ok);
    const open = await kit.run(['update', 'web/T2', '--decided', '--note', 'x', '--session', 'lead']);
    assert.deepEqual([open.code, open.stdout], [EXIT.refused, ['REFUSED T2 waits on no decision or approval of owner: only such a card is decided']]);
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

describe("leaders across the tree: the parent team's lead approves a child team's lead (T1140)", () => {
  /** The tree with web/T1, web's lead's, waiting on app/lead's approval; `root` adds to app's config. */
  async function asking(root: JsonRecord = {}): Promise<CliHarness> {
    const kit = await treeHarness(root);
    assert.equal((await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'lead'], { env: WEB })).code, EXIT.ok);
    const set = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:app/lead', '--note', 'branch t1', '--session', 'lead'], { env: WEB });
    assert.equal(set.code, EXIT.ok, [...set.stdout, ...set.stderr].join('\n'));
    return kit;
  }

  it("tells the parent's lead in its own inbox, and the parent's lead's answer reaches web's register and lead", async () => {
    const kit = await asking();
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), '- 2030-01-08 10:00 web/lead: web/T1 waits on your approval: branch t1\n');
    const approved = await kit.run(['approve', 'web/T1', '--note', 'tests green', '--session', 'lead']);
    assert.equal(approved.code, EXIT.ok, [...approved.stdout, ...approved.stderr].join('\n'));
    assert.match(approved.stdout[0] ?? '', /^APPROVED web\/T1 /);
    const event = readEvents(kit.files.get(teamEventsOf('web')) ?? '').events.at(-1);
    assert.deepEqual([event?.by, event?.type], ['app/lead', 'update']);
    assert.match(kit.files.get(teamInboxOf('web', 'lead')) ?? '', /app\/lead: app\/lead approved web\/T1: tests green; push or merge it now/);
  });

  it("keeps a wait on the parent team's lead off the child lead's PEER-WAIT flags", async () => {
    const kit = await asking();
    const checked = await kit.run(['check', '--all', '--session', 'lead'], { env: WEB });
    assert.equal(checked.code, EXIT.ok);
    assert.doesNotMatch(checked.stdout.join('\n'), /PEER-WAIT/);
  });

  it("sends a grandchild lead's wait to its parent's lead, web/lead, in web's inbox", async () => {
    const kit = await treeHarness();
    const ui = { env: { TEAMRIG_TEAM: 'ui' } };
    assert.equal((await kit.run(['add', '--title', 'New icons', '--description', 'what and why', '--priority', 'p1', '--session', 'lead'], ui)).code, EXIT.ok);
    const set = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:web/lead', '--note', 'icons branch', '--session', 'lead'], ui);
    assert.equal(set.code, EXIT.ok, [...set.stdout, ...set.stderr].join('\n'));
    assert.equal(kit.files.get(teamInboxOf('web', 'lead')), '- 2030-01-08 10:00 ui/lead: ui/T1 waits on your approval: icons branch\n');
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), undefined);
  });

  it("sends a child lead's own wait on the owner to the parent team's lead, its leader (T1265)", async () => {
    const kit = await treeHarness();
    assert.equal((await kit.run(['add', '--title', 'Pick a host', '--description', 'what and why', '--priority', 'p1', '--session', 'lead'], { env: WEB })).code, EXIT.ok);
    const set = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'the cost', ...TEST_OWNER_CARD_FLAGS, '--session', 'lead'], { env: WEB });
    assert.equal(set.code, EXIT.ok, [...set.stdout, ...set.stderr].join('\n'));
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), `- 2030-01-08 10:00 web/lead: web/T1 waits on the owner's decision: ${TEST_OWNER_CARD.question} | asked in the next batch at the daily meeting\n`);
    assert.equal(kit.files.get(teamInboxOf('web', 'lead')), undefined, 'never to the lead who set it');
  });

  it("joins a child lead's wait on the parent lead's approval and on the owner in one line to that lead (T1265)", async () => {
    const kit = await treeHarness();
    assert.equal((await kit.run(['add', '--title', 'Pick a host', '--description', 'what and why', '--priority', 'p1', '--session', 'lead'], { env: WEB })).code, EXIT.ok);
    const set = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:app/lead,decision:owner', '--note', 'the cost', ...TEST_OWNER_CARD_FLAGS, '--session', 'lead'], { env: WEB });
    assert.equal(set.code, EXIT.ok, [...set.stdout, ...set.stderr].join('\n'));
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), `- 2030-01-08 10:00 web/lead: web/T1 waits on your approval and the owner's decision: ${TEST_OWNER_CARD.question} | asked in the next batch at the daily meeting\n`);
  });

  it("refuses all but the parent team's lead, a root team, an unknown team, its own team and no note, writing nothing", async () => {
    const kit = await asking();
    const before = filesOf(kit);
    const refusals: [readonly string[], Record<string, string>, RegExp][] = [
      [['web/T1', '--session', 'alpha'], {}, /^REFUSED only app\/lead, the lead of team web's parent, approves its tasks from another team; app\/alpha may not$/],
      [['web/T1', '--session', 'lead'], { TEAMRIG_TEAM: 'ops' }, /; ops\/lead may not$/],
      [['web/T1', '--session', 'lead'], { TEAMRIG_TEAM: 'ui' }, /; ui\/lead may not$/],
      [['app/T1', '--session', 'lead'], WEB, /^REFUSED team app has no parent team, so only its own leaders approve its tasks$/],
      [['blog/T1', '--session', 'lead'], {}, /^REFUSED no team blog with a config in this kit home$/],
    ];
    for (const [extra, env, line] of refusals) {
      const result = await kit.run(['approve', ...extra, '--note', 'ok'], { env });
      assert.equal(result.code, EXIT.refused, extra.join(' '));
      assert.match(result.stdout[0] ?? '', line);
    }
    const own = await kit.run(['approve', 'app/T1', '--note', 'ok', '--session', 'lead']);
    assert.equal(own.code, EXIT.usage);
    assert.match(own.stderr[0] ?? '', /^app\/T1 is a task of your own team: approve T1/);
    const bare = await kit.run(['approve', 'web/T1', '--session', 'lead']);
    assert.notEqual(bare.code, EXIT.ok);
    assert.match([...bare.stdout, ...bare.stderr].join('\n'), /an answer needs --note/);
    assert.deepEqual(filesOf(kit), before);
  });

  it("under pushToProtected lead, clears a child lead's push only once the parent team's lead approved it", async () => {
    const guarded = { pushGuard: { pushToProtected: 'lead' } };
    const kit = await asking(guarded);
    await kit.files.write(teamConfigOf('web'), formatConfig({ ...SUB_TEAMS['web'], ...guarded }));
    const push = (env: Record<string, string>) => kit.run(['hook', 'push-guard'], { stdin: bash('git push origin main'), env });
    const webLead = { ...WEB, TEAMRIG_SESSION: 'lead' };
    assert.match(
      reasonOf(await push(webLead)) ?? '',
      /: app\/lead, the lead of the parent team, has approved no waiting task of lead's\. Ask on the register: `teamrig set <task> --status waiting --waits approval:app\/lead /,
    );
    assert.match((await push({ TEAMRIG_SESSION: 'lead' })).stdout[0] ?? '', /the lead \(lead\) pushes unasked/);
    assert.equal((await kit.run(['approve', 'web/T1', '--note', 'tests green', '--session', 'lead'])).code, EXIT.ok);
    assert.match((await push(webLead)).stdout[0] ?? '', /^\{"systemMessage":"teamrig let this push .* app\/lead approved T1; set its next status once pushed/);
    assert.equal(await kit.files.remove(CONFIG_PATH), true);
    assert.match(reasonOf(await push(webLead)) ?? '', /: team app, the parent team, has no config to name its lead\./);
  });
});

describe("an owner wait due before the next batch, in a child team, wakes the lead at the tree's root (T1277)", () => {
  /** app's batch times; the clock is Tue 01-08 10:00, so a wait due 12:00 is due before the 13:03 batch. */
  const BATCHED = { decisions: { batchTimesUtc: ['13:03', '19:03'], batchAt: 2 } };
  const AT_ONCE = `${TEST_OWNER_CARD.question} | AT ONCE, due Tue 01-08 12:00 UTC before the next batch`;
  const WOKEN = "NOTE T1 is due before the owner's next batch: its line wakes app-lead, who asks the owner, so no message is needed";
  const AT = Date.parse('2030-01-08T10:00:00Z');

  /** Adds a task of `session`'s on `team`, due 12:00 unless `due` is empty, and sets it waiting on the owner; returns the set's stderr. */
  async function ownerWait(kit: CliHarness, team: string, session: string, options: { files?: Files; due?: string } = {}): Promise<readonly string[]> {
    const env = { TEAMRIG_TEAM: team };
    const due = options.due ?? '2030-01-08 12:00';
    const added = await kit.run(['add', '--title', 'Pick a host', '--description', 'what and why', '--priority', 'p1', ...(due === '' ? [] : ['--due', due]), '--session', session], { env });
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    const set = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'the cost', ...TEST_OWNER_CARD_FLAGS, '--session', session], { env, files: options.files ?? kit.files });
    assert.equal(set.code, EXIT.ok, [`code ${set.code}`, ...set.stdout, ...set.stderr].join('\n'));
    return set.stderr;
  }

  async function asksOf(kit: CliHarness, team: string, id: string): Promise<readonly (WakeAsk | undefined)[]> {
    return (await new WakeAsks(kit.files, wakeAsksOf(team)).read(id)).map((stored) => stored.ask);
  }

  it("posts the root lead a line and its wake; the member's own lead keeps its line, unwoken", async () => {
    const kit = await treeHarness(BATCHED);
    const line = `web/T1 waits on the owner's decision: ${AT_ONCE}`;
    assert.deepEqual(await ownerWait(kit, 'web', 'front'), [
      `NOTE lead has an inbox line: T1 waits on the owner's decision: ${AT_ONCE}`,
      `NOTE app/lead has an inbox line: ${line}`,
      WOKEN,
    ]);
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), `- 2030-01-08 10:00 web/front: ${line}\n`);
    assert.deepEqual(await asksOf(kit, 'app', 'lead'), [{ from: 'web/front', text: line, at: AT }]);
    assert.deepEqual(await asksOf(kit, 'web', 'lead'), []);
  });

  it("wakes the parent team's lead on the one line a child lead's own wait sends it", async () => {
    const kit = await treeHarness(BATCHED);
    const line = `web/T1 waits on the owner's decision: ${AT_ONCE}`;
    assert.deepEqual(await ownerWait(kit, 'web', 'lead'), [`NOTE app/lead has an inbox line: ${line}`, WOKEN]);
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), `- 2030-01-08 10:00 web/lead: ${line}\n`);
    assert.deepEqual(await asksOf(kit, 'app', 'lead'), [{ from: 'web/lead', text: line, at: AT }]);
  });

  it("wakes the root lead past a grandchild lead's parent lead, who keeps its line, unwoken", async () => {
    const kit = await treeHarness(BATCHED);
    const line = `ui/T1 waits on the owner's decision: ${AT_ONCE}`;
    assert.deepEqual(await ownerWait(kit, 'ui', 'lead'), [`NOTE web/lead has an inbox line: ${line}`, `NOTE app/lead has an inbox line: ${line}`, WOKEN]);
    assert.deepEqual(await asksOf(kit, 'app', 'lead'), [{ from: 'ui/lead', text: line, at: AT }]);
    assert.deepEqual(await asksOf(kit, 'web', 'lead'), []);
  });

  it('wakes no one, and tells the root lead nothing, for a wait the next batch holds', async () => {
    const kit = await treeHarness(BATCHED);
    assert.equal((await ownerWait(kit, 'web', 'front', { due: '' })).length, 1);
    assert.equal(kit.files.get(teamInboxOf('app', 'lead')), undefined);
    assert.deepEqual([await asksOf(kit, 'app', 'lead'), await asksOf(kit, 'web', 'lead')], [[], []]);
  });

  it("tells the setter to message the root lead when the root team's wakes are off", async () => {
    const kit = await treeHarness({ ...BATCHED, wake: { enabled: false } });
    assert.equal((await ownerWait(kit, 'web', 'front')).at(-1), "NOTE T1 is due before the owner's next batch: message app-lead, who asks the owner, as an inbox line wakes no one");
    assert.deepEqual(await asksOf(kit, 'app', 'lead'), []);
  });

  it('tells the setter to message the root lead when its wake cannot be asked, its line posted', async () => {
    const kit = await treeHarness(BATCHED);
    const ask = join(wakeAsksOf('app'), 'lead', `${AT}-0.json`);
    const files = new FaultyFiles(kit.files).fail('createExclusive', ask, systemError('EACCES', 'EACCES: permission denied'));
    assert.equal(
      (await ownerWait(kit, 'web', 'front', { files })).at(-1),
      "WARN T1 is due before the owner's next batch, and app-lead's wake could not be asked (EACCES: permission denied): message app-lead, who asks the owner",
    );
    assert.match(kit.files.get(teamInboxOf('app', 'lead')) ?? '', /web\/T1 waits on the owner's decision/);
  });

  it("tells the setter to message the root lead, asking no wake, when the root team's secret patterns refuse its line", async () => {
    const kit = await treeHarness({ ...BATCHED, register: { secretPatterns: ['pricing tier'] } });
    const stderr = await ownerWait(kit, 'web', 'front');
    assert.match(stderr[1] ?? '', /^WARN app\/lead was not told of the wait on it: /);
    assert.equal(stderr[2], "NOTE T1 is due before the owner's next batch: message app-lead, who asks the owner, as its line could not be posted");
    assert.deepEqual(await asksOf(kit, 'app', 'lead'), []);
  });
});
