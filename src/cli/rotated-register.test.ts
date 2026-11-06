import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_DAY } from '../core/time.ts';
import { layoutPaths } from '../register/layout.ts';
import { CliHarness, EVENTS_PATH } from '../testing/cli-harness.ts';
import { rotateRegister } from '../testing/rotation.ts';
import { teamEventsOf, treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const AS_ALPHA = { env: { TEAMRIG_SESSION: 'alpha' } };

async function runAll(kit: CliHarness, steps: readonly (readonly string[])[], env: Readonly<Record<string, string>> = {}): Promise<void> {
  for (const argv of steps) {
    const result = await kit.run(argv, { env });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
  }
}

/**
 * A register rotated twenty days after its first week: T1 (planned in that week) is done and T2 dropped,
 * so a compaction retires both; T3 is open in the current week plan.
 */
async function rotatedKit(): Promise<CliHarness> {
  const kit = new CliHarness();
  await runAll(kit, [
    ['add', '--title', 'Old plan', '--description', 'what and why', '--priority', 'p2', '--week', '2030-01-07', '--session', 'alpha'],
    ['set', 'T1', '--status', 'done', '--note', 'shipped', '--evidence', 'abc1234', '--skill', 'none', '--followups', 'none', '--session', 'alpha'],
    ['add', '--title', 'Dropped idea', '--description', 'what and why', '--priority', 'p3', '--session', 'alpha'],
    ['set', 'T2', '--status', 'dropped', '--note', 'not needed', '--session', 'alpha'],
    ['add', '--title', 'Current plan', '--description', 'what and why', '--priority', 'p1', '--week', '2030-01-21', '--session', 'alpha'],
  ]);
  kit.clock.advance(20 * MS_PER_DAY);
  const compaction = await rotateRegister(kit.files, EVENTS_PATH, { now: new Date(kit.clock.now()) });
  assert.deepEqual(compaction.retiredNow, ['T1', 'T2']);
  return kit;
}

/** The task ids of the rows a command printed, in order; header lines name none. */
function ids(lines: readonly string[]): string[] {
  return lines.flatMap((line) => /^(?:[\w-]+\/)?T\d+(?= )/.exec(line) ?? []);
}

describe('the CLI on a rotated register', () => {
  it('lists active tasks from the working set alone, with no archive to read', async () => {
    const kit = await rotatedKit();
    await kit.files.remove(layoutPaths(EVENTS_PATH).segment(1));
    const listed = await kit.run(['list'], AS_ALPHA);
    assert.deepEqual([listed.code, ids(listed.stdout), listed.stderr], [EXIT.ok, ['T3'], []]);
    const checked = await kit.run(['check'], AS_ALPHA);
    assert.deepEqual(checked.stdout.slice(0, 5), [
      'CHECK 3 flag(s), week 2030-01-21 (short form; --all for every flag in full)',
      'UNTRIAGED 1 (no class, added by alpha: class it (update T3 --class <name>))',
      '  T3 open, Improvements, score 3.33, p1, owner alpha | Current plan',
      'NO-PROGRESS 1 (no goal or week-plan task moved since 01-27 00:00 UTC (1 day); the first to move)',
      '  T3 open, Improvements, score 3.33, p1, owner alpha | Current plan',
    ]);
    const full = await kit.run(['check', '--all'], AS_ALPHA);
    assert.match(full.stdout.join('\n'), /STALE[^\n]*last event 01-08 10:00 UTC by alpha/);
    const planned = await kit.run(['plan'], AS_ALPHA);
    assert.match(planned.stdout.join('\n'), /2030-01-21[\s\S]*Current plan/);
  });

  it('reads the whole history to list finished tasks and to show a retired one', async () => {
    const kit = await rotatedKit();
    assert.deepEqual(ids((await kit.run(['list', '--status', 'done'], AS_ALPHA)).stdout), ['T1']);
    assert.deepEqual(ids((await kit.run(['list', '--status', 'all'], AS_ALPHA)).stdout), ['T3', 'T1', 'T2']);
    const shown = await kit.run(['show', 'T1'], AS_ALPHA);
    assert.equal(shown.code, EXIT.ok);
    assert.match(shown.stdout.join('\n'), /Old plan[\s\S]*shipped/);
    const missing = await kit.run(['show', 'T9'], AS_ALPHA);
    assert.deepEqual([missing.code, missing.stdout], [EXIT.refused, ['REFUSED no task T9']]);
  });

  it("reads the whole history for a week plan as old as the retired tasks' newest", async () => {
    const kit = await rotatedKit();
    const old = await kit.run(['plan', '--week', '2030-01-07'], AS_ALPHA);
    assert.match(old.stdout.join('\n'), /Old plan/);
    const current = await kit.run(['plan', '--week', '2030-01-21'], AS_ALPHA);
    assert.doesNotMatch(current.stdout.join('\n'), /Old plan/);
  });

  it('names a retired task as archived when asked to change it', async () => {
    const kit = await rotatedKit();
    const result = await kit.run(['set', 'T1', '--status', 'open', '--session', 'alpha']);
    assert.deepEqual([result.code, result.stdout], [EXIT.refused, ['REFUSED no task T1 in the working set: if it was finished long ago it is archived (teamrig show T1)']]);
  });

  it('warns once about damaged lines, from the register it finally read', async () => {
    const kit = await rotatedKit();
    await kit.files.append(EVENTS_PATH, '{torn\n');
    const listed = await kit.run(['list', '--status', 'done'], AS_ALPHA);
    assert.equal(listed.stderr.length, 1);
    assert.match(listed.stderr[0] ?? '', /1 unreadable line\(s\)/);
  });

  it('reads the whole history of each team of a tree that needs it', async () => {
    const kit = await treeHarness();
    await runAll(kit, [
      ['add', '--team', 'web', '--title', 'Old web task', '--description', 'what and why', '--priority', 'p2', '--session', 'lead'],
    ]);
    await runAll(kit, [['set', 'T1', '--status', 'done', '--note', 'shipped', '--evidence', 'abc1234', '--skill', 'none', '--followups', 'none', '--session', 'lead']], { TEAMRIG_TEAM: 'web' });
    kit.clock.advance(20 * MS_PER_DAY);
    await rotateRegister(kit.files, teamEventsOf('web'), { now: new Date(kit.clock.now()) });
    const active = await kit.run(['list', '--tree', '--session', 'lead']);
    assert.deepEqual(ids(active.stdout), []);
    const done = await kit.run(['list', '--tree', '--status', 'done', '--session', 'lead']);
    assert.deepEqual(ids(done.stdout), ['web/T1']);
  });
});
