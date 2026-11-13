import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { TEAM_HOME } from '../../testing/cli-harness.ts';
import { treeHarness } from '../../testing/team-tree.ts';
import { EXIT } from '../runtime.ts';

const SCHEDULE = join(TEAM_HOME, 'state', 'day-schedule.json');
const AS_LEAD = ['--session', 'lead'];
const WEB = { env: { TEAMRIG_TEAM: 'web' } };

describe('teamrig schedule', () => {
  it("says no schedule is written when there is none, each team's wake.dayStartUtc holding", async () => {
    const kit = await treeHarness();
    const result = await kit.run(['schedule', ...AS_LEAD]);
    assert.deepEqual(result, { code: EXIT.ok, stdout: ["SCHEDULE 2030-01-08: none written; each team's wake.dayStartUtc holds"], stderr: [] });
  });

  it('shows the starts written for the day, and repeats them on a later day not written, from a child team too', async () => {
    const kit = await treeHarness();
    await kit.files.write(SCHEDULE, `${JSON.stringify({ v: 1, days: { '2030-01-08': { app: '07:00', 'web/front': 'none' } } })}\n`);
    const today = await kit.run(['schedule', ...AS_LEAD]);
    assert.deepEqual(today.stdout, ["SCHEDULE 2030-01-08 (UTC; a key not listed keeps its team's wake.dayStartUtc):", '  app 07:00', '  web/front none']);
    const later = await kit.run(['schedule', '--day', '2030-01-10', '--session', 'front'], WEB);
    assert.deepEqual(later.stdout, ["SCHEDULE 2030-01-10 (UTC; a key not listed keeps its team's wake.dayStartUtc):", '  app 07:00 (repeats 2030-01-08)', '  web/front none (repeats 2030-01-08)']);
  });

  it('refuses a --day that is not a day', async () => {
    const kit = await treeHarness();
    const result = await kit.run(['schedule', '--day', '01-08', ...AS_LEAD]);
    assert.equal(result.code, EXIT.usage);
    assert.match([...result.stdout, ...result.stderr].join('\n'), /--day "01-08" is not a day/);
  });
});

describe('teamrig schedule set', () => {
  it("writes the root lead's starts for a team and a session given by name, which schedule then shows", async () => {
    const kit = await treeHarness();
    const result = await kit.run(['schedule', 'set', '--day', '2030-01-09', '--start', 'app=07:30,web/web-front=none', ...AS_LEAD]);
    assert.deepEqual(result, {
      code: EXIT.ok,
      stdout: ['SCHEDULED 2030-01-09 (UTC): app 07:30, web/front none', '  each start wakes its idle sessions once; later days repeat it until one is written (1 day(s) kept)'],
      stderr: [],
    });
    assert.equal(kit.files.get(SCHEDULE), `${JSON.stringify({ v: 1, days: { '2030-01-09': { app: '07:30', 'web/front': 'none' } } })}\n`);
    const shown = await kit.run(['schedule', '--day', '2030-01-09', ...AS_LEAD]);
    assert.deepEqual(shown.stdout.slice(1), ['  app 07:30', '  web/front none']);
  });

  const refusals: readonly [string, readonly string[], { readonly env: Record<string, string> } | undefined, RegExp][] = [
    ['a session that is not the lead', ['--start', 'app=07:00', '--session', 'alpha'], undefined, /REFUSED/],
    ["a child team's lead", ['--start', 'web=07:00', '--session', 'lead'], WEB, /the day schedule is the root team's: web sits under app/],
    ['a past day', ['--day', '2030-01-07', '--start', 'app=07:00', ...AS_LEAD], undefined, /--day 2030-01-07 is past/],
    ['a team outside the tree', ['--start', 'mobile=07:00', ...AS_LEAD], undefined, /--start "mobile": name a team of this tree/],
    ['a session its team lacks', ['--start', 'web/nobody=07:00', ...AS_LEAD], undefined, /nobody/],
  ];
  for (const [what, flags, options, reason] of refusals) {
    it(`refuses ${what}, writing nothing`, async () => {
      const kit = await treeHarness();
      const result = await kit.run(['schedule', 'set', ...flags], options);
      assert.notEqual(result.code, EXIT.ok);
      assert.match([...result.stdout, ...result.stderr].join('\n'), reason);
      assert.equal(kit.files.get(SCHEDULE), undefined);
    });
  }

  it("refuses a start inside the team's quiet hours, and a start that is not a time", async () => {
    const kit = await treeHarness({ budget: { enabled: true, quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'ask' } } });
    const quiet = await kit.run(['schedule', 'set', '--start', 'app=05:00', ...AS_LEAD]);
    assert.match(quiet.stdout.join('\n'), /05:00 is inside app's quiet hours \(22:00-06:00 UTC\)/);
    const malformed = await kit.run(['schedule', 'set', '--start', 'app=7am', ...AS_LEAD]);
    assert.equal(malformed.code, EXIT.usage);
    assert.equal(kit.files.get(SCHEDULE), undefined);
  });
});
