import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import type { Sleep } from '../core/lock.ts';
import { CLI_PID, CliHarness, TEAM_HOME } from '../testing/cli-harness.ts';
import { holdFileLock } from '../testing/held-file-lock.ts';
import type { CliResult, RunOptions } from '../testing/cli-harness.ts';
import { SUB_TEAMS, teamConfigOf, teamEventsOf, teamHomeOf, treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const ROOT_IDS_LOCK = join(teamHomeOf('app'), 'state', 'ids.lock');

function inTeam(team: string, extra: RunOptions = {}): RunOptions {
  return { ...extra, env: { TEAMRIG_TEAM: team } };
}

function add(title: string, ...extra: readonly string[]): string[] {
  return ['add', '--title', title, '--description', 'what and why', '--priority', 'p2', '--session', 'lead', ...extra];
}

/** The task id an `add` printed on its `ADDED` line, its team's prefix included when it wrote another team's register. */
function addedId(result: CliResult): string | undefined {
  return /^ADDED (\S+) /.exec(result.stdout[0] ?? '')?.[1];
}

/** A lock on the tree's numbering that another running process took a moment ago. */
async function holdRootIdsLock(kit: CliHarness, path = ROOT_IDS_LOCK): Promise<void> {
  await holdFileLock(kit, path);
}

/** A wait that lets every other run in flight go as far as it can first, as another process would. */
const yieldToOthers: Sleep = () => new Promise((resolve) => setImmediate(resolve));

describe('one task numbering across a team tree (T1139)', () => {
  it('numbers each new task once across the tree, whichever team adds it, and leaves no lock behind', async () => {
    const kit = await treeHarness();
    const runs: readonly [readonly string[], RunOptions][] = [
      [add('Root task'), {}],
      [add('Web task', '--owner', 'front'), inTeam('web')],
      [add('Icons', '--team', 'ui'), inTeam('web')],
      [add('Ops task', '--owner', 'run'), inTeam('ops')],
      [add('Root again'), {}],
    ];
    const ids: (string | undefined)[] = [];
    for (const [argv, options] of runs) {
      ids.push(addedId(await kit.run(argv, options)));
    }
    assert.deepEqual(ids, ['T1', 'T2', 'ui/T3', 'T4', 'T5']);
    assert.equal(kit.files.get(ROOT_IDS_LOCK), undefined);
  });

  it("waits on the root team's lock while another add in the tree holds it, and gives up writing nothing", async () => {
    const kit = await treeHarness();
    await holdRootIdsLock(kit);
    const result = await kit.run(add('Web task', '--owner', 'front'), inTeam('web'));
    assert.equal(result.code, EXIT.failed);
    assert.deepEqual(result.stderr, [`FAILED ${ROOT_IDS_LOCK} is held by another process (waited 20000 ms); retry`]);
    assert.ok(kit.clock.sleeps.length > 0);
    assert.equal(kit.files.get(teamEventsOf('web')), undefined);
  });

  it('takes no tree lock for a team in no tree, so its numbers stay its own', async () => {
    const kit = new CliHarness();
    const lock = join(TEAM_HOME, 'state', 'ids.lock');
    await holdRootIdsLock(kit, lock);
    const result = await kit.run(add('Alone'));
    assert.deepEqual([result.code, addedId(result)], [EXIT.ok, 'T1']);
    assert.deepEqual(kit.clock.sleeps, []);
  });

  it('falls back to their own numbers for teams whose parents go round a loop', async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('web'), formatConfig({ ...SUB_TEAMS['web'], team: { id: 'web', parent: 'ui' } }));
    await kit.run(add('Root task'));
    await holdRootIdsLock(kit);
    const web = await kit.run(add('Web task', '--owner', 'front'), inTeam('web'));
    const ui = await kit.run(add('Icons', '--owner', 'pixel'), inTeam('ui'));
    assert.deepEqual([addedId(web), addedId(ui)], ['T1', 'T1']);
    assert.deepEqual(kit.clock.sleeps, []);
  });

  it('makes a team whose parent has no config the root of the teams below it', async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('web'), formatConfig({ ...SUB_TEAMS['web'], team: { id: 'web', parent: 'blog' } }));
    const ids: (string | undefined)[] = [];
    for (const [argv, options] of [
      [add('Root task'), {}],
      [add('Web task', '--owner', 'front'), inTeam('web')],
      [add('Icons', '--owner', 'pixel'), inTeam('ui')],
    ] satisfies [string[], RunOptions][]) {
      ids.push(addedId(await kit.run(argv, options)));
    }
    assert.deepEqual(ids, ['T1', 'T1', 'T2']);
  });

  it('gives two adds started at once in two teams of the tree different numbers', async () => {
    const kit = await treeHarness();
    // Both adds run as the kit's one pid, which runs, so each waits while the other holds the tree's lock.
    kit.sessionProcesses.add({ pid: CLI_PID, parentPid: 1, name: 'node', commandLine: 'node teamrig add' });
    const results = await Promise.all([
      kit.run(add('Root task'), { sleep: yieldToOthers }),
      kit.run(add('Web task', '--owner', 'front'), inTeam('web', { sleep: yieldToOthers })),
    ]);
    assert.deepEqual(results.map((result) => result.code), [EXIT.ok, EXIT.ok]);
    assert.deepEqual(results.map(addedId).sort(), ['T1', 'T2']);
  });
});
