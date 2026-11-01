import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../core/home.ts';
import { TEST_OWNER_CARD_FLAGS } from '../testing/card.ts';
import type { CliHarness } from '../testing/cli-harness.ts';
import { treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const APP: Env = {};
const WEB = { TEAMRIG_TEAM: 'web' };
const OPS = { TEAMRIG_TEAM: 'ops' };
const UI = { TEAMRIG_TEAM: 'ui' };

/** The root's batch times; the clock is Tue 01-08 10:00 UTC, after the 19:03 one of the day before. Due at 3 waits. */
const BATCHED = { decisions: { batchTimesUtc: ['13:03', '19:03'], batchAt: 3 } };
const ASKS_UP = '  app/lead asks owner these in its batches and records each answer on its task as a note: "owner decided: <decision>".';

/** Adds a task of `session`'s in the team of `env` and sets it waiting on the owner's decision, with its card; returns what the set printed on stderr. */
async function ownerWait(kit: CliHarness, env: Env, session: string, title: string): Promise<readonly string[]> {
  const added = await kit.run(['add', '--title', title, '--description', 'what and why', '--priority', 'p2', '--session', session], { env });
  assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
  const id = /^ADDED (T\d+)/.exec(added.stdout[0] ?? '')?.[1] ?? '';
  const set = await kit.run(['set', id, '--status', 'waiting', '--waits', 'decision:owner', '--note', 'two options', ...TEST_OWNER_CARD_FLAGS, '--session', session], { env });
  assert.equal(set.code, EXIT.ok, set.stderr.join('\n'));
  return set.stderr;
}

/** The ids of the card rows `decisions` prints, in order. */
function rowIds(stdout: readonly string[]): string[] {
  return stdout.flatMap((line) => /^ {2}(\S+) waiting/.exec(line)?.[1] ?? []);
}

async function checkDecisions(kit: CliHarness, env: Env): Promise<readonly string[]> {
  return (await kit.run(['check', '--session', 'lead'], { env })).stdout.filter((line) => line.startsWith('DECISIONS'));
}

describe("runCli: a child team's owner decisions go up to the lead at its tree's root (T509)", () => {
  it("refuses a child team's lead the owner's daily meeting, naming the root's lead, and lets the root's lead hold it", async () => {
    const kit = await treeHarness();
    for (const [env, team] of [
      [WEB, 'web'],
      [UI, 'ui'],
    ] as const) {
      for (const command of ['start', 'agenda', 'end']) {
        const refused = await kit.run(['meeting', command, '--session', 'lead'], { env });
        assert.deepEqual(
          [refused.code, refused.stdout],
          [EXIT.refused, [`REFUSED team ${team} meets no owner: the owner's daily meeting is app/lead's, whose agenda lists ${team}'s waits on the owner`]],
        );
      }
    }
    const member = await kit.run(['meeting', 'start', '--session', 'front'], { env: WEB });
    assert.deepEqual(member.stdout, ["REFUSED only the lead (web-lead) runs the owner's daily meeting"]);
    const root = await kit.run(['meeting', 'start', '--session', 'lead']);
    assert.equal(root.code, EXIT.ok, root.stderr.join('\n'));
  });

  it("holds every child team's waits in the root lead's batch, each labelled with its team, on the root's batch times (T1018)", async () => {
    const kit = await treeHarness(BATCHED);
    await ownerWait(kit, APP, 'alpha', 'Pick the pricing tier');
    const second = await ownerWait(kit, WEB, 'front', 'Pick the landing page');
    assert.ok(
      second.some((line) => line.endsWith('| asked in the next batch Tue 01-08 13:03 UTC')),
      second.join('\n'),
    );
    const third = await ownerWait(kit, UI, 'pixel', 'Pick the icon set');
    assert.ok(
      third.some((line) => line.endsWith('| BATCH DUE: 3 not yet asked, decisions.batchAt is 3')),
      `a grandchild's wait counts in the root's batch: ${third.join('\n')}`,
    );
    assert.deepEqual(await checkDecisions(kit, APP), ['DECISIONS batch due (3 not yet asked, decisions.batchAt is 3): 3 to ask, 0 past due; teamrig decisions --session lead']);
    assert.deepEqual(await checkDecisions(kit, WEB), [], "a child team's lead asks the owner nothing");

    const listed = await kit.run(['decisions', '--session', 'lead']);
    assert.equal(listed.code, EXIT.ok, listed.stderr.join('\n'));
    assert.deepEqual(rowIds(listed.stdout), ['T1', 'web/T2', 'ui/T3'], 'one numbering across the tree');
    const asked = await kit.run(['decisions', 'asked', '--session', 'lead']);
    assert.deepEqual(asked.stdout, ['ASKED 3 decision(s) Tue 01-08 10:00 UTC: T1, web/T2, ui/T3; the next batch Tue 01-08 13:03 UTC holds the waits set since and the ones past due']);
    assert.deepEqual(await checkDecisions(kit, APP), []);
  });

  it("shows a child team its own and its teams' waits of the root's batch, names who asks them, and refuses it the asking (T1018)", async () => {
    const kit = await treeHarness(BATCHED);
    await ownerWait(kit, APP, 'alpha', 'Pick the pricing tier');
    await ownerWait(kit, WEB, 'front', 'Pick the landing page');
    await ownerWait(kit, UI, 'pixel', 'Pick the icon set');
    await ownerWait(kit, OPS, 'run', 'Pick the host');

    const web = await kit.run(['decisions', '--session', 'front'], { env: WEB });
    assert.equal(web.code, EXIT.ok, web.stderr.join('\n'));
    assert.equal(web.stdout[0], 'DECISIONS 2 to ask owner, 0 asked and past due; BATCH DUE: 4 not yet asked, decisions.batchAt is 3');
    assert.deepEqual(rowIds(web.stdout), ['web/T2', 'ui/T3'], "neither the root's own wait nor a sibling team's");
    assert.deepEqual(web.stdout.slice(-1), [ASKS_UP]);
    assert.deepEqual(rowIds((await kit.run(['decisions', '--session', 'pixel'], { env: UI })).stdout), ['ui/T3']);

    const refused = await kit.run(['decisions', 'asked', '--session', 'lead'], { env: WEB });
    assert.deepEqual([refused.code, refused.stdout], [EXIT.refused, ["REFUSED team web asks no owner: app/lead asks the owner web's waits, in its batches"]]);
    const member = await kit.run(['decisions', 'asked', '--session', 'front'], { env: WEB });
    assert.deepEqual(member.stdout, ["REFUSED only the lead (web-lead) asks the owner's decisions"]);
    assert.deepEqual(rowIds((await kit.run(['decisions', '--session', 'lead'])).stdout), ['T1', 'ops/T4', 'web/T2', 'ui/T3'], 'nothing was recorded asked, the teams depth first');
  });

  it("reads the waits of every team under the root lead at its meeting, and tells each decided task's owner in its own team at the end (T1018)", async () => {
    const kit = await treeHarness();
    await ownerWait(kit, APP, 'alpha', 'Pick the pricing tier');
    await ownerWait(kit, WEB, 'front', 'Pick the landing page');
    await ownerWait(kit, UI, 'pixel', 'Pick the icon set');
    const started = await kit.run(['meeting', 'start', '--session', 'lead']);
    assert.equal(started.code, EXIT.ok, started.stderr.join('\n'));
    assert.equal(started.stdout[1], 'STATS app, 7 d: 01-02 to 01-08 (tree: app, ops, web, ui)', "the stats' top lines cover the root lead's tree (T1771)");
    assert.ok(started.stdout.includes('DECISIONS 3 waiting on owner (decision or approval)'), started.stdout.join('\n'));
    assert.deepEqual(rowIds(started.stdout), ['T1', 'web/T2', 'ui/T3'], 'its own first, then the teams under it depth first');

    for (const [label, note] of [['T1', 'human decided: basic'], ['web/T2', 'human decided: ship it']] as const) {
      const noted = await kit.run(['update', label, '--note', note, '--session', 'lead']);
      assert.equal(noted.code, EXIT.ok, noted.stderr.join('\n'));
    }
    const ended = await kit.run(['meeting', 'end', '--session', 'lead']);
    assert.equal(ended.code, EXIT.ok, ended.stderr.join('\n'));
    assert.match(ended.stdout[0] ?? '', /told 2 session\(s\) the decisions on their tasks$/);
    assert.ok(ended.stdout.includes('  alpha T1: human decided: basic'), ended.stdout.join('\n'));
    assert.ok(ended.stdout.includes('  web/front T2: human decided: ship it'), ended.stdout.join('\n'));

    const front = (await kit.run(['inbox', 'read', '--session', 'front'], { env: WEB })).stdout;
    const told = front.filter((line) => line.includes('Decided on your tasks:'));
    assert.equal(told.length, 1, front.join('\n'));
    assert.match(told[0] ?? '', /app\/lead: the owner's daily meeting with app-lead ended .*\. Decided on your tasks: T2: human decided: ship it\.$/);
    const pixel = (await kit.run(['inbox', 'read', '--session', 'pixel'], { env: UI })).stdout;
    assert.ok(!pixel.some((line) => line.includes('Decided on your tasks:')), "a team's session with nothing decided gets no line");
  });
});
