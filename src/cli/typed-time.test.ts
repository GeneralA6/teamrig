import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { MAIN_CHECKOUT } from '../testing/fake-merge-git.ts';
import { EXIT } from './runtime.ts';

/** The harness clock, 2030-01-08 10:00 UTC, reads 12:00 IST on this machine. */
const JERUSALEM = { timeZone: 'Asia/Jerusalem' };
const LEDGER = join(TEAM_HOME, 'state', 'deploys', 'ledger.jsonl');
/** A team whose app repository deploys cloud-web on push, so stable-periods has a target to read. */
const DEPLOYING = { ...TEAM, delivery: { repos: { app: { mainCheckout: MAIN_CHECKOUT, deploysOnPush: ['cloud-web'] } } } };

describe("runCli: a time typed on the team's clock", () => {
  it('stores a typed due minute in UTC, so it prints back as typed, zone-marked', async () => {
    const kit = new CliHarness();
    const added = await kit.run(['add', '--title', 'Ship it', '--description', 'what and why', '--priority', 'p2', '--due', '2030-01-09 09:00', '--session', 'alpha'], JERUSALEM);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    assert.match(added.stdout[0] ?? '', /due 01-09 09:00 IST/, 'a zone lost on the way in or out prints 07:00 or 11:00');

    const updated = await kit.run(['update', 'T1', '--due', '16:00', '--session', 'alpha'], JERUSALEM);
    assert.match(updated.stdout[0] ?? '', /due 01-08 16:00 IST/, 'HH:MM is today on the zone clock');

    const waiting = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'time:2030-01-09 08:00', '--note', 'after the window', '--session', 'alpha'], JERUSALEM);
    assert.equal(waiting.code, EXIT.ok, waiting.stderr.join('\n'));
    assert.match(waiting.stdout[0] ?? '', /until Wed 01-09 08:00 IST/);
  });

  it('ends a --due-before day at midnight on the zone clock and reads a minute there', async () => {
    const kit = new CliHarness();
    await kit.run(['add', '--title', 'Ship it', '--description', 'what and why', '--priority', 'p2', '--due', '2030-01-08 16:00', '--session', 'alpha'], JERUSALEM);
    const listed = async (before: string): Promise<readonly string[]> =>
      (await kit.run(['list', '--session', 'alpha', '--due-before', before], JERUSALEM)).stdout.filter((line) => line.includes('T1'));
    assert.equal((await listed('2030-01-08')).length, 1, 'due 16:00 IST is before the end of 01-08 there');
    assert.equal((await listed('2030-01-08 16:30')).length, 1);
    assert.equal((await listed('2030-01-08 15:30')).length, 0, '15:30 IST is before the due');
  });

  it('starts a job at a typed --at on the zone clock', async () => {
    const kit = new CliHarness(TEAM);
    const started = await kit.run(['job', '--session', 'alpha', '--what', 'backfill', '--at', '09:00'], JERUSALEM);
    assert.equal(started.code, EXIT.ok, started.stderr.join('\n'));
    const records = (kit.files.get(LEDGER) ?? '').trim().split('\n').map((line): unknown => JSON.parse(line));
    assert.deepEqual(
      records.map((record) => (typeof record === 'object' && record !== null && 'startedAt' in record ? record.startedAt : undefined)),
      ['2030-01-08T07:00:00.000Z'],
    );
  });

  it('reads stable-periods --since on the zone clock', async () => {
    const kit = new CliHarness(DEPLOYING);
    const since = async (time: string, options?: typeof JERUSALEM) => kit.run(['stable-periods', '--targets', 'cloud-web', '--since', time], options);
    assert.match((await since('12:30', JERUSALEM)).stderr[0] ?? '', /^--since 2030-01-08 12:30 IST is not before now \(2030-01-08 12:00 IST\)\n/, 'the refusal prints on the clock it read');
    assert.match((await since('11:30')).stderr[0] ?? '', /^--since 2030-01-08 11:30 UTC is not before now \(2030-01-08 10:00 UTC\)\n/, 'a UTC machine reads it as UTC');
    const local = await since('11:30', JERUSALEM);
    assert.equal(local.code, EXIT.ok, `11:30 IST is 09:30 UTC, before the clock: ${local.stderr.join('\n')}`);
  });
});
