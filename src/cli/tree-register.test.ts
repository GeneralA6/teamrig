import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readEvents } from '../register/store.ts';
import { EVENTS_PATH } from '../testing/cli-harness.ts';
import { teamEventsOf, treeHarness } from '../testing/team-tree.ts';
import type { CliHarness } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const WEB = { TEAMRIG_TEAM: 'web' };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };

describe('teamrig add --team', () => {
  it('hands a child team a task from its parent lead, written in the child register only', async () => {
    const kit = await treeHarness();
    const result = await kit.run(['add', '--team', 'web', '--title', 'Ship login', '--priority', 'p2', '--session', 'lead']);
    assert.deepEqual(result, { code: EXIT.ok, stdout: ['ADDED web/T1 open, p2, owner lead, from app/lead | Ship login'], stderr: [] });
    const [event] = readEvents(kit.files.get(teamEventsOf('web')) ?? '').events;
    assert.deepEqual([event?.by, event?.type], ['app/lead', 'create']);
    assert.equal(kit.files.get(EVENTS_PATH), undefined);
    const queue = await kit.run(['list', '--session', 'lead'], { env: WEB });
    assert.deepEqual(queue.stdout, ['T1 open, p2, owner lead, from app/lead | Ship login']);
    const started = await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'lead'], { env: WEB });
    assert.equal(started.code, EXIT.ok);
    const reprioritized = await kit.run(['update', 'T1', '--priority', 'p1', '--session', 'lead'], { env: WEB });
    assert.equal(reprioritized.code, EXIT.ok);
  });

  it("lets a sub-team lead hand its own child team a task, by the lead's name", async () => {
    const kit = await treeHarness();
    const result = await kit.run(['add', '--team', 'ui', '--title', 'New icons', '--priority', 'p1', '--session', 'web-lead'], { env: WEB });
    assert.deepEqual(result.stdout, ['ADDED ui/T1 open, p1, owner lead, from web/lead | New icons']);
  });

  it('refuses all but the parent lead, a root team, an unknown team and --owner or --source, writing nothing', async () => {
    const kit = await treeHarness();
    const refusals: [readonly string[], Record<string, string>, string][] = [
      [['--team', 'web', '--session', 'alpha'], {}, "REFUSED only web's parent lead (app/lead) adds tasks to it; app/alpha may not"],
      [['--team', 'ui', '--session', 'lead'], {}, "REFUSED only ui's parent lead (web/lead) adds tasks to it; app/lead may not"],
      [['--team', 'app', '--session', 'lead'], WEB, 'REFUSED team app has no parent team, so only its own sessions add its tasks'],
      [['--team', 'blog', '--session', 'lead'], {}, 'REFUSED no team blog with a config in this kit home'],
    ];
    for (const [extra, env, line] of refusals) {
      const result = await kit.run(['add', '--title', 'Ship login', '--priority', 'p2', ...extra], { env });
      assert.deepEqual([result.code, result.stdout], [EXIT.refused, [line]]);
    }
    for (const flag of ['--owner', '--source']) {
      const result = await kit.run(['add', '--team', 'web', '--title', 'x', '--priority', 'p2', flag, 'front', '--session', 'lead']);
      assert.equal(result.code, EXIT.usage);
      assert.match(result.stderr[0] ?? '', /^--team gives the task to that team's lead, from you: it takes no --owner or --source/);
    }
    for (const team of ['app', 'web', 'ui']) {
      assert.equal(kit.files.get(teamEventsOf(team)), undefined, team);
    }
  });
});

/** The tree with one task in `app` (overdue, in the week plan), one handed to `web` and one in `ui`. */
async function seeded(): Promise<CliHarness> {
  const kit = await treeHarness();
  const runs = [
    kit.run(['add', '--title', 'Root task', '--priority', 'p1', '--owner', 'alpha', '--week', '2030-01-07', '--due', '2030-01-07', '--session', 'lead']),
    kit.run(['add', '--team', 'web', '--title', 'Ship login', '--priority', 'p2', '--week', '2030-01-07', '--session', 'lead']),
    kit.run(['add', '--title', 'Icons', '--priority', 'p2', '--owner', 'pixel', '--session', 'lead'], { env: { TEAMRIG_TEAM: 'ui' } }),
  ];
  for (const run of runs) {
    assert.equal((await run).code, EXIT.ok);
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
    const result = await kit.run(['list', '--tree'], AS_LEAD);
    assert.deepEqual(result, {
      code: EXIT.ok,
      stdout: [
        'app/T1 open, p1, owner alpha, due 01-07, week 01-07, from lead | Root task',
        'web/T1 open, p2, owner lead, week 01-07, from app/lead | Ship login',
        'ui/T1 open, p2, owner pixel, from lead | Icons',
      ],
      stderr: [],
    });
    const fromParent = await kit.run(['list', '--tree', '--source', 'app/lead'], AS_LEAD);
    assert.deepEqual(fromParent.stdout, ['web/T1 open, p2, owner lead, week 01-07, from app/lead | Ship login']);
    const byName = await kit.run(['list', '--tree', '--source', 'app-lead'], AS_LEAD);
    assert.deepEqual(byName.stdout, ['app/T1 open, p1, owner alpha, due 01-07, week 01-07, from lead | Root task']);
    const sub = await kit.run(['list', '--tree'], { env: { ...WEB, TEAMRIG_SESSION: 'lead' } });
    assert.deepEqual(sub.stdout.map((line) => line.split(' ')[0]), ['web/T1', 'ui/T1']);
    assert.deepEqual(filesOf(kit), before);
  });

  it('checks every team against the lead week, then the shared skills folder once', async () => {
    const kit = await seeded();
    const result = await kit.run(['check', '--tree', '--session', 'lead']);
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
  });

  it('plans one section per team for the lead week', async () => {
    const kit = await seeded();
    const result = await kit.run(['plan', '--tree', '--session', 'lead']);
    const headings = result.stdout.join('\n').split('\n').filter((line) => line.startsWith('# '));
    assert.deepEqual(headings, ['# Week plan 2030-01-07, team app', '# Week plan 2030-01-07, team ops', '# Week plan 2030-01-07, team web', '# Week plan 2030-01-07, team ui']);
    assert.match(result.stdout.join('\n'), /- \[ \] \*\*web\/T1\*\* Ship login \(lead · from app\/lead\)/);
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
    assert.ok(byFlag.stdout.some((line) => line.startsWith('web/T1 ')));
    const own = await kit.run(['list', '--session', 'lead']);
    assert.ok(own.stdout.every((line) => !line.startsWith('web/')));
  });
});
