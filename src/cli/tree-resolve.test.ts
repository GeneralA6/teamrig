import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { CliHarness, CliResult, RunOptions } from '../testing/cli-harness.ts';
import { teamEventsOf, teamHomeOf, treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const WEB: RunOptions = { env: { TEAMRIG_TEAM: 'web' } };

function add(title: string, ...extra: readonly string[]): string[] {
  return ['add', '--title', title, '--description', 'what and why', '--priority', 'p2', '--session', 'lead', ...extra];
}

function waitOn(id: string, target: string, session: string): string[] {
  return ['set', id, '--status', 'waiting', '--waits', `task:${target}`, '--note', `needs ${target}`, '--session', session];
}

async function ok(kit: CliHarness, argv: readonly string[], options: RunOptions = {}): Promise<CliResult> {
  const result = await kit.run(argv, options);
  assert.equal(result.code, EXIT.ok, [...argv, ...result.stdout, ...result.stderr].join(' '));
  return result;
}

/** App holds T1, open and owned by its lead; web holds T2, owned by front and in progress. */
async function seeded(): Promise<CliHarness> {
  const kit = await treeHarness();
  await ok(kit, add('Root task'));
  await ok(kit, add('Web task', '--owner', 'front'), WEB);
  await ok(kit, ['set', 'T2', '--status', 'in-progress', '--session', 'front'], WEB);
  return kit;
}

describe("a write in one team of a tree reads its other registers' tasks (T1139)", () => {
  it("accepts a wait on a task another team of the tree holds, and an add planned after one, as not yet ready", async () => {
    const kit = await seeded();
    const waiting = await ok(kit, waitOn('T2', 'T1', 'front'), WEB);
    assert.match(waiting.stdout[0] ?? '', /^SET T2 waiting/);
    assert.ok(!(waiting.stdout[0] ?? '').includes('ready'), waiting.stdout[0]);
    const after = await ok(kit, add('After the root task', '--owner', 'back', '--after', 'T1'), WEB);
    assert.match(after.stdout[0] ?? '', /^ADDED T3 open, p2, owner back, after T1, from lead \| After the root task$/);
  });

  it('refuses a wait on a task another team of the tree has finished', async () => {
    const kit = await seeded();
    await ok(kit, ['set', 'T1', '--status', 'dropped', '--note', 'not needed', '--session', 'lead']);
    const result = await kit.run(waitOn('T2', 'T1', 'front'), WEB);
    assert.deepEqual([result.code, result.stdout], [EXIT.refused, ['REFUSED T1 is already finished; nothing to wait on']]);
  });

  it("refuses a change to another team's task, and writes neither register", async () => {
    const kit = await seeded();
    const before = [kit.files.get(teamEventsOf('web')), kit.files.get(teamEventsOf('app'))];
    const result = await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'lead'], WEB);
    assert.deepEqual(
      [result.code, result.stdout],
      [EXIT.refused, ["REFUSED T1 is team app's task (owner lead): only a session of team app changes it"]],
    );
    assert.deepEqual([kit.files.get(teamEventsOf('web')), kit.files.get(teamEventsOf('app'))], before);
  });

  it("refuses a wait that closes a loop through another team's task", async () => {
    const kit = await seeded();
    await ok(kit, waitOn('T2', 'T1', 'front'), WEB);
    await ok(kit, ['set', 'T1', '--status', 'in-progress', '--session', 'lead']);
    const result = await kit.run(waitOn('T1', 'T2', 'lead'));
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stdout[0] ?? '', /^REFUSED T1 .*T2.* would be a loop, and no task in a loop can finish: /);
  });
});

/** Whether a `check --all` run flags T2 READY: the long form prints each flag's kind and task on one line. */
function readyT2(result: CliResult): boolean {
  return result.stdout.some((line) => /^READY .*\bT2\b/.test(line));
}

describe("a read in one team of a tree judges a wait on another register's task against it (T1139)", () => {
  it('flags the wait READY only once the other team finishes the task', async () => {
    const kit = await seeded();
    await ok(kit, waitOn('T2', 'T1', 'front'), WEB);
    assert.equal(readyT2(await ok(kit, ['check', '--all', '--session', 'front'], WEB)), false);
    await ok(kit, ['set', 'T1', '--status', 'dropped', '--note', 'not needed', '--session', 'lead']);
    assert.equal(readyT2(await ok(kit, ['check', '--all', '--session', 'front'], WEB)), true);
  });

  it('judges each team of a roll-up against the registers the roll-up read', async () => {
    const kit = await seeded();
    await ok(kit, waitOn('T2', 'T1', 'front'), WEB);
    assert.equal(readyT2(await ok(kit, ['check', '--all', '--tree', '--session', 'lead'])), false);
    await ok(kit, ['set', 'T1', '--status', 'dropped', '--note', 'not needed', '--session', 'lead']);
    assert.equal(readyT2(await ok(kit, ['check', '--all', '--tree', '--session', 'lead'])), true);
  });

  it('shows the task waited on as its row in the register holding it', async () => {
    const kit = await seeded();
    await ok(kit, waitOn('T2', 'T1', 'front'), WEB);
    const shown = await ok(kit, ['show', 'T2', '--tree', '--session', 'front'], WEB);
    assert.ok(shown.stdout.some((line) => /^ {2}app\/T1 open\b/.test(line)), shown.stdout.join('\n'));
  });
});

describe('show of a task another register of the tree holds (T1139)', () => {
  const held = "HELD by team app: only a session of team app changes it, and its history is in that team's register";

  it('shows its row read-only, named by the team that holds it', async () => {
    const kit = await seeded();
    const shown = await ok(kit, ['show', 'T1', '--session', 'front'], WEB);
    assert.equal(shown.stdout.length, 3, shown.stdout.join('\n'));
    assert.match(shown.stdout[0] ?? '', /^app\/T1 open, Improvements, score 3\.33, p2, owner lead\b.*\| Root task$/);
    assert.equal(shown.stdout[1], held);
    assert.equal(shown.stdout[2], `files in ${join(teamHomeOf('app'), 'tasks', 'T1')}: none yet`, 'its files are in the team that holds it');
  });

  it("walks its tree in that team's register, naming that team in each row and move", async () => {
    const kit = await seeded();
    await ok(kit, add('Second root task', '--after', 'T1'));
    const shown = await ok(kit, ['show', 'T3', '--tree', '--session', 'front'], WEB);
    assert.match(shown.stdout[0] ?? '', /^app\/T3 open, Improvements, score 3\.33, p2, owner lead, after T1\b.*\| Second root task$/);
    assert.deepEqual(shown.stdout.slice(1, 3), [held, 'needs:']);
    assert.match(shown.stdout[3] ?? '', /^ {2}app\/T1 open\b/);
    assert.deepEqual(shown.stdout.slice(4), ['needed by: none', 'Next move: lead on team app (app/T1)']);
  });

  it('refuses an id no register of the tree holds', async () => {
    const kit = await seeded();
    const result = await kit.run(['show', 'T9', '--session', 'front'], WEB);
    assert.deepEqual([result.code, result.stdout], [EXIT.refused, ['REFUSED no task T9']]);
  });
});
