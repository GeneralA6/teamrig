import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FIVE_HOUR_SUMMARY_FILE, formatFiveHourSummary, type FiveHourFold } from '../budget/five-hour-summary.ts';
import { MS_PER_HOUR } from '../core/time.ts';
import { CliHarness, KIT, TEAM, TEAM_HOME, type RunOptions } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const AS_ALPHA: RunOptions = { env: { TEAMRIG_SESSION: 'alpha' } };
const AS_LEAD: RunOptions = { env: { TEAMRIG_SESSION: 'lead' } };
const ON = { ...TEAM, budget: { enabled: true } };
const SUMMARY = join(KIT, 'usage', 'live', FIVE_HOUR_SUMMARY_FILE);
const SOURCE = 'from the five-hour check [budget.fiveHourWarnPct]:';

const RESETS_AT = Date.parse('2030-01-08T13:00:00Z');
/** The harness's clock. */
const NOW = Date.parse('2030-01-08T10:00:00Z');

/** 30% at 09:30 and 60% at 10:00: 60 points an hour, full at 10:40, long before its 13:00 reset. */
const RISING: FiveHourFold = { resetsAt: RESETS_AT, usedPct: 60, at: NOW, firstPct: 30, firstAt: Date.parse('2030-01-08T09:30:00Z') };
/** 10% at 09:00 and 12% at 10:00: 2 points an hour, 18% at the reset. */
const SLOW: FiveHourFold = { resetsAt: RESETS_AT, usedPct: 12, at: NOW, firstPct: 10, firstAt: Date.parse('2030-01-08T09:00:00Z') };
/** 78% at 08:00 and 81% at 10:00: 1.5 points an hour, 85.5% at the reset, so only the mark sees it. */
const STEADY: FiveHourFold = { resetsAt: RESETS_AT, usedPct: 81, at: NOW, firstPct: 78, firstAt: Date.parse('2030-01-08T08:00:00Z') };

/** The lead's check rows from the five-hour check. */
async function fiveHourRows(kit: CliHarness): Promise<string[]> {
  const result = await kit.run(['check', '--all'], AS_LEAD);
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  return result.stdout.filter((line) => line.includes('the five-hour check'));
}

/** The lead's inbox lines from the five-hour check, after one `start` of another session. */
async function toldAfterStart(kit: CliHarness): Promise<string[]> {
  assert.equal((await kit.run(['start'], AS_ALPHA)).code, EXIT.ok);
  const inbox = (await kit.files.read(join(TEAM_HOME, 'state', 'inbox', 'lead.md'))) ?? '';
  return inbox.split('\n').filter((line) => line.includes('the five-hour check [budget.fiveHourWarnPct] raised a warning no session owns'));
}

describe('check FIVE-HOUR (T1968)', () => {
  it('says nothing with the budget off, even with a window about to fill', async () => {
    const kit = new CliHarness(TEAM);
    await kit.files.write(SUMMARY, formatFiveHourSummary(RISING));
    assert.deepEqual(await fiveHourRows(kit), []);
  });

  it('says nothing on a plan with no five-hour window: its status line writes no summary', async () => {
    assert.deepEqual(await fiveHourRows(new CliHarness(ON)), []);
  });

  it('says nothing of a window under the mark that resets before it fills', async () => {
    const kit = new CliHarness(ON);
    await kit.files.write(SUMMARY, formatFiveHourSummary(SLOW));
    assert.deepEqual(await fiveHourRows(kit), []);
  });

  it('warns of a rise that fills the window before its reset, well under the mark', async () => {
    const kit = new CliHarness(ON);
    await kit.files.write(SUMMARY, formatFiveHourSummary(RISING));
    assert.deepEqual(await fiveHourRows(kit), [
      `${SOURCE} FIVE-HOUR the account's five-hour window read 60.0% at 10:00 UTC, rising 60.0 points an hour, full by 10:40 UTC; at 100% every session stalls until it resets 13:00 UTC`,
    ]);
  });

  it('warns at budget.fiveHourWarnPct of a steady rise the forecast keeps under 100%', async () => {
    const kit = new CliHarness(ON);
    await kit.files.write(SUMMARY, formatFiveHourSummary(STEADY));
    assert.deepEqual(await fiveHourRows(kit), [
      `${SOURCE} FIVE-HOUR the account's five-hour window read 81.0% at 10:00 UTC, rising 1.5 points an hour; at 100% every session stalls until it resets 13:00 UTC`,
    ]);
  });

  it('holds the warning to the mark the team set', async () => {
    const kit = new CliHarness({ ...TEAM, budget: { enabled: true, fiveHourWarnPct: 90 } });
    await kit.files.write(SUMMARY, formatFiveHourSummary(STEADY));
    assert.deepEqual(await fiveHourRows(kit), []);
  });

  it('warns of a full window, which no rate is read from', async () => {
    const kit = new CliHarness(ON);
    await kit.files.write(SUMMARY, formatFiveHourSummary({ ...STEADY, usedPct: 100 }));
    assert.deepEqual(await fiveHourRows(kit), [
      `${SOURCE} FIVE-HOUR the account's five-hour window read 100.0% at 10:00 UTC; at 100% every session stalls until it resets 13:00 UTC`,
    ]);
  });

  it('stops warning once the window has reset', async () => {
    const kit = new CliHarness(ON);
    await kit.files.write(SUMMARY, formatFiveHourSummary(RISING));
    kit.clock.advance(3 * MS_PER_HOUR);
    assert.deepEqual(await fiveHourRows(kit), []);
  });

  it("tells the lead once a window from any session's start, however its forecast flaps, and again for the next window", async () => {
    const kit = new CliHarness(ON);
    await kit.files.write(SUMMARY, formatFiveHourSummary(RISING));
    const [told, ...rest] = await toldAfterStart(kit);
    assert.match(told ?? '', /so it is yours as lead: FIVE-HOUR the account's five-hour window read 60\.0% at 10:00 UTC/);
    assert.deepEqual(rest, []);

    await kit.files.write(SUMMARY, formatFiveHourSummary(SLOW));
    assert.equal((await toldAfterStart(kit)).length, 1);
    await kit.files.write(SUMMARY, formatFiveHourSummary(RISING));
    assert.equal((await toldAfterStart(kit)).length, 1);

    await kit.files.write(SUMMARY, formatFiveHourSummary({ ...RISING, resetsAt: RESETS_AT + MS_PER_HOUR }));
    assert.equal((await toldAfterStart(kit)).length, 2);
  });
});
