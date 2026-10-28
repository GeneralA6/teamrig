import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CliHarness, TEAM, TEAM_HOME, type RunOptions } from '../testing/cli-harness.ts';
import { failedState, formatIdlePassState, IDLE_PASS_STALE_MS, passedState } from './idle-pass-log.ts';
import { EXIT } from './runtime.ts';

const AS_ALPHA: RunOptions = { env: { TEAMRIG_SESSION: 'alpha' } };
const AS_LEAD: RunOptions = { env: { TEAMRIG_SESSION: 'lead' } };
const DRY_RUN = { ...TEAM, open: { idle: { mode: 'dry-run' } } };
const OFF = { ...TEAM, open: { idle: { mode: 'off' } } };
const STATE = join(TEAM_HOME, 'state', 'idle-pass.json');
const ROW = 'from the idle pass check [open.idle.mode]: FLEET-STALE the idle pass (open.idle.mode dry-run)';

/** The lead's check rows from the idle pass check. */
async function fleetRows(kit: CliHarness): Promise<string[]> {
  const result = await kit.run(['check', '--all'], AS_LEAD);
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  return result.stdout.filter((line) => line.includes('the idle pass check'));
}

describe('check FLEET-STALE (T1100)', () => {
  it('never flags with open.idle.mode off, even with a stale pass', async () => {
    const kit = new CliHarness(OFF);
    await kit.files.write(STATE, formatIdlePassState(passedState(kit.clock.now() - 2 * IDLE_PASS_STALE_MS, [])));
    assert.deepEqual(await fleetRows(kit), []);
  });

  it('flags no pass yet with the mode on by default: the new or just-upgraded team waits for its first idle tab (T1409)', async () => {
    assert.deepEqual(await fleetRows(new CliHarness(TEAM)), []);
  });

  it('flags a pass past IDLE_PASS_STALE_MS, but not a fresh one', async () => {
    const kit = new CliHarness(DRY_RUN);
    await kit.files.write(STATE, formatIdlePassState(passedState(kit.clock.now() - 60_000, [])));
    assert.deepEqual(await fleetRows(kit), []);
    kit.clock.advance(IDLE_PASS_STALE_MS);
    const [stale, ...rest] = await fleetRows(kit);
    assert.equal(stale?.startsWith(`${ROW} last ran 16 min ago: `), true, stale);
    assert.deepEqual(rest, []);
  });

  it('flags a fresh pass that failed', async () => {
    const kit = new CliHarness(DRY_RUN);
    await kit.files.write(STATE, formatIdlePassState(failedState(undefined, kit.clock.now(), 'EACCES')));
    assert.deepEqual(await fleetRows(kit), [`${ROW} failed at its last run, 0 min ago: EACCES; state/idle-pass.jsonl logs each new failure`]);
  });

  it("tells the lead once from any session's start, as every warning no session owns", async () => {
    const kit = new CliHarness(DRY_RUN);
    await kit.files.write(STATE, formatIdlePassState(passedState(kit.clock.now() - 2 * IDLE_PASS_STALE_MS, [])));
    for (let run = 0; run < 2; run += 1) {
      assert.equal((await kit.run(['start'], AS_ALPHA)).code, EXIT.ok);
    }
    const inbox = (await kit.files.read(join(TEAM_HOME, 'state', 'inbox', 'lead.md'))) ?? '';
    const lines = inbox.split('\n').filter((line) => line.includes('the idle pass check [open.idle.mode] raised a warning no session owns'));
    assert.equal(lines.length, 1, inbox);
    assert.match(lines[0] ?? '', /so it is yours as lead: FLEET-STALE the idle pass \(open\.idle\.mode dry-run\) last ran 30 min ago: /);
  });
});
