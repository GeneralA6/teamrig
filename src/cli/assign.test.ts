import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { WakeAsks } from '../wake/asks.ts';
import { EXIT } from './runtime.ts';

const TOLD = 'NOTE bravo has an inbox line: T1 is yours (p2, due 2030-01-10): Ship the docs';

async function inboxOf(kit: CliHarness, session: string): Promise<string[]> {
  const read = await kit.run(['inbox', 'read', '--session', session]);
  return read.stdout.filter((line) => line.startsWith('- '));
}

describe('runCli: giving a task to another session posts it an inbox line', () => {
  it('tells the owner of a task added for it, and nobody of a task the caller keeps', async () => {
    const kit = new CliHarness();
    const added = await kit.run(['add', '--title', 'Ship the docs', '--description', 'what and why', '--priority', 'p2', '--due', '2030-01-10', '--owner', 'bravo', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    assert.match(added.stdout[0] ?? '', /^ADDED T1 /);
    assert.deepEqual(added.stderr, [TOLD]);
    assert.deepEqual(await inboxOf(kit, 'bravo'), ['- 2030-01-08 10:00 UTC alpha: T1 is yours (p2, due 2030-01-10): Ship the docs']);

    const kept = await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
    assert.deepEqual([kept.code, kept.stderr], [EXIT.ok, []]);
    assert.deepEqual(await inboxOf(kit, 'alpha'), []);
  });

  it('tells the new owner of a reassigned task, and nobody when the owner stays', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
    const moved = await kit.run(['update', 'T1', '--owner', 'bravo', '--session', 'lead']);
    assert.equal(moved.code, EXIT.ok, moved.stderr.join('\n'));
    assert.deepEqual(moved.stderr, ['NOTE bravo has an inbox line: T1 is yours (p1): Ship the CLI']);

    const reprioritized = await kit.run(['update', 'T1', '--priority', 'p2', '--session', 'lead']);
    assert.deepEqual([reprioritized.code, reprioritized.stderr], [EXIT.ok, []]);
    const taken = await kit.run(['update', 'T1', '--owner', 'lead', '--session', 'lead']);
    assert.deepEqual([taken.code, taken.stderr], [EXIT.ok, []]);
    assert.deepEqual(await inboxOf(kit, 'lead'), []);
  });

  it('takes a note alone on a task the caller does not own, and tells nobody', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
    const noted = await kit.run(['update', 'T1', '--note', 'the ask came with 72 of 75 cold wakes', '--session', 'bravo']);
    assert.equal(noted.code, EXIT.ok, noted.stderr.join('\n'));
    assert.match(noted.stdout[0] ?? '', /^UPDATED T1 /);
    assert.deepEqual(noted.stderr, []);
    assert.deepEqual(await inboxOf(kit, 'alpha'), []);

    const empty = await kit.run(['update', 'T1', '--session', 'bravo']);
    assert.notEqual(empty.code, EXIT.ok);
    assert.match([...empty.stdout, ...empty.stderr].join('\n'), /REFUSED nothing to change: give a field or a --note/);
  });

  it('points a note-only set to update --note, which keeps the status and any answer (#701)', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
    const noted = await kit.run(['set', 'T1', '--note', 'half the specs pass', '--session', 'alpha']);
    assert.notEqual(noted.code, EXIT.ok);
    assert.equal(
      noted.stderr[0]?.split('\n')[0],
      '--status is required; a note alone goes through teamrig update T1 --note "..", which keeps the status and any answer given (a set restating the same waits asks again)',
    );
    const bare = await kit.run(['set', 'T1', '--session', 'alpha']);
    assert.equal(bare.stderr[0]?.split('\n')[0], '--status is required');
  });

  it('names a line it could not post, and keeps the task', async () => {
    const kit = new CliHarness({ ...TEAM, register: { secretPatterns: ['is yours'] } });
    const added = await kit.run(['add', '--title', 'Ship the docs', '--description', 'what and why', '--priority', 'p2', '--owner', 'bravo', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok);
    assert.match(added.stdout[0] ?? '', /^ADDED T1 /);
    assert.deepEqual(added.stderr.map((line) => line.split(':')[0]), ['WARN bravo was not told of T1']);
    assert.deepEqual(await inboxOf(kit, 'bravo'), []);
  });
});

describe("runCli: a p0 handed to another session says its team's wake check wakes it (T2686)", () => {
  const WOKEN = 'NOTE bravo is woken at its idle prompt for T1, a p0, so no --wake now is needed';

  async function handed(kit: CliHarness, priority: string): Promise<readonly string[]> {
    const added = await kit.run(['add', '--title', 'Ship the change', '--description', 'what and why', '--priority', priority, '--owner', 'bravo', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    return added.stderr;
  }

  it('names the wake of a p0, and of no p1, whose wake check waits for the budget and quiet hours', async () => {
    assert.deepEqual(await handed(new CliHarness(), 'p0'), ['NOTE bravo has an inbox line: T1 is yours (p0): Ship the change', WOKEN]);
    assert.deepEqual(await handed(new CliHarness(), 'p1'), ['NOTE bravo has an inbox line: T1 is yours (p1): Ship the change']);
  });

  it('names the wake of a blocker, the level above p0 (T4329)', async () => {
    assert.deepEqual(await handed(new CliHarness(), 'blocker'), [
      'NOTE bravo has an inbox line: T1 is yours (blocker): Ship the change',
      'NOTE bravo is woken at its idle prompt for T1, a blocker, so no --wake now is needed',
      'NOTE lead has an inbox line: T1 is a blocker of bravo: Ship the change; bravo drops the rest to fix it now (take it over, or lower it to p0 if it blocks no one)',
    ]);
  });

  it('names no wake while the team has wakes off, nor for a line it could not post', async () => {
    assert.deepEqual(await handed(new CliHarness({ ...TEAM, wake: { enabled: false } }), 'p0'), ['NOTE bravo has an inbox line: T1 is yours (p0): Ship the change']);
    const unsent = await handed(new CliHarness({ ...TEAM, register: { secretPatterns: ['is yours'] } }), 'p0');
    assert.deepEqual(unsent.map((line) => line.split(':')[0]), ['WARN bravo was not told of T1']);
  });
});

describe("runCli: a task made a blocker wakes the owner's leader and the lead at once (T4329)", () => {
  const ASKS = join(TEAM_HOME, 'state', 'wake-asks');
  const NOTICE = 'T1 is a blocker of bravo: Restore the queue; bravo drops the rest to fix it now (take it over, or lower it to p0 if it blocks no one)';

  async function asksOf(kit: CliHarness, session: string): Promise<(string | undefined)[]> {
    return (await new WakeAsks(kit.files, ASKS).read(session)).map((stored) => stored.ask?.text);
  }

  it("tells the owner's sub-lead, with a wake ask, and not the lead who added it", async () => {
    const kit = new CliHarness({ ...TEAM, leads: { alpha: ['bravo'] } });
    const added = await kit.run(['add', '--title', 'Restore the queue', '--description', 'every merge waits on it', '--priority', 'blocker', '--owner', 'bravo', '--session', 'lead']);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    assert.deepEqual(await inboxOf(kit, 'alpha'), [`- 2030-01-08 10:00 UTC lead: ${NOTICE}`]);
    assert.deepEqual(await asksOf(kit, 'alpha'), [NOTICE]);
    assert.deepEqual(await inboxOf(kit, 'lead'), []);
  });

  it('tells the lead when the owner raises its own task to a blocker, and nobody when it already was one', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Restore the queue', '--description', 'every merge waits on it', '--priority', 'p1', '--session', 'bravo']);
    const raised = await kit.run(['update', 'T1', '--priority', 'blocker', '--session', 'bravo']);
    assert.equal(raised.code, EXIT.ok, raised.stderr.join('\n'));
    assert.deepEqual(await inboxOf(kit, 'lead'), [`- 2030-01-08 10:00 UTC bravo: ${NOTICE}`]);
    assert.deepEqual(await asksOf(kit, 'lead'), [NOTICE]);

    const noted = await kit.run(['update', 'T1', '--note', 'the queue log shows the lock held', '--session', 'bravo']);
    assert.deepEqual([noted.code, await inboxOf(kit, 'lead')], [EXIT.ok, []]);
  });

  it('tells no leader of a p0', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Restore the queue', '--description', 'every merge waits on it', '--priority', 'p0', '--session', 'bravo']);
    assert.deepEqual(await inboxOf(kit, 'lead'), []);
  });
});
