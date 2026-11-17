import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { LineFrontStore, lineFrontPath } from '../delivery/line-front-store.ts';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

/** The team's front file, in its state folder. */
const FRONT = lineFrontPath(join(TEAM_HOME, 'state'));

/** A harness whose register holds `count` open tasks, T1 to T<count>, added by alpha. */
async function withTasks(count: number): Promise<CliHarness> {
  const kit = new CliHarness(TEAM);
  for (let n = 1; n <= count; n += 1) {
    const added = await kit.run(['add', '--title', `Task ${n}`, '--description', 'what and why', '--priority', 'p2', '--class', 'Maintenance', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
  }
  return kit;
}

describe('teamrig pipeline front', () => {
  it('puts an active task at the front, by the lead, and a new front replaces the last (T4082)', async () => {
    const kit = await withTasks(2);
    assert.deepEqual(await kit.run(['pipeline', 'front', 'T1', '--session', 'lead']), { code: EXIT.ok, stdout: ['FRONT T1: its queued steps go first in the host line'], stderr: [] });
    assert.deepEqual(await new LineFrontStore(kit.files, FRONT).read(), { task: 'T1', at: '2030-01-08T10:00:00.000Z', by: 'lead' });
    assert.deepEqual((await kit.run(['pipeline', 'front', 'T2', '--session', 'lead'])).stdout, ['FRONT T2: its queued steps go first in the host line (replaces T1)']);
    assert.equal((await new LineFrontStore(kit.files, FRONT).read())?.task, 'T2');
  });

  it('keeps the time of a task fronted again, so its place among the teams does not move back', async () => {
    const kit = await withTasks(1);
    await new LineFrontStore(kit.files, FRONT).put({ task: 'T1', at: '2030-01-08T09:00:00.000Z', by: 'lead' });
    assert.deepEqual((await kit.run(['pipeline', 'front', 'T1', '--session', 'lead'])).stdout, ['FRONT T1: already at the front of the host line']);
    assert.equal((await new LineFrontStore(kit.files, FRONT).read())?.at, '2030-01-08T09:00:00.000Z');
  });

  it('takes the front off with --off, and says so when none was there', async () => {
    const kit = await withTasks(1);
    assert.equal((await kit.run(['pipeline', 'front', 'T1', '--session', 'lead'])).code, EXIT.ok);
    assert.deepEqual(await kit.run(['pipeline', 'front', '--off', '--session', 'lead']), { code: EXIT.ok, stdout: ["OFF T1: its queued steps wait in the line's usual order again"], stderr: [] });
    assert.equal(kit.files.get(FRONT), undefined);
    assert.deepEqual((await kit.run(['pipeline', 'front', '--off', '--session', 'lead'])).stdout, ['OFF none: no task was at the front of the host line']);
  });

  it('refuses a session that is not the lead, writing nothing', async () => {
    const kit = await withTasks(1);
    assert.deepEqual(await kit.run(['pipeline', 'front', 'T1', '--session', 'alpha']), { code: EXIT.refused, stdout: ['REFUSED only the lead (app-lead) puts a task at the front of the host line'], stderr: [] });
    assert.deepEqual((await kit.run(['pipeline', 'front', '--off', '--session', 'bravo'])).stdout, ['REFUSED only the lead (app-lead) takes a task off the front of the host line']);
    assert.equal(kit.files.get(FRONT), undefined);
  });

  it('refuses a task the register lacks or one no longer active, writing nothing', async () => {
    const kit = await withTasks(1);
    assert.deepEqual((await kit.run(['pipeline', 'front', 'T9', '--session', 'lead'])).stdout, ['REFUSED the register has no T9']);
    assert.equal((await kit.run(['set', 'T1', '--status', 'dropped', '--note', 'not needed', '--session', 'alpha'])).code, EXIT.ok);
    assert.deepEqual((await kit.run(['pipeline', 'front', 'T1', '--session', 'lead'])).stdout, ['REFUSED T1 is dropped: only an active task (open, in-progress, verifying, waiting) goes to the front']);
    assert.equal(kit.files.get(FRONT), undefined);
  });

  it('is a usage error with no task, a task beside --off, two tasks or a word that is no task id', async () => {
    const kit = await withTasks(2);
    for (const words of [[], ['T1', '--off'], ['T1', 'T2'], ['blocker']]) {
      assert.equal((await kit.run(['pipeline', 'front', ...words, '--session', 'lead'])).code, EXIT.usage, words.join(' '));
    }
    assert.equal(kit.files.get(FRONT), undefined);
  });
});
