import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { APP, CliHarness, TEAM, type CliResult } from '../testing/cli-harness.ts';
import { formatConfig } from '../config/load.ts';
import type { JsonRecord } from '../core/guards.ts';
import { ok } from '../testing/hired-team.ts';
import { teamConfigOf } from '../testing/team-tree.ts';

/**
 * The harness clock is Tuesday 2030-01-08 10:00 UTC; the status line's week resets on Monday 2030-01-14 01:00 UTC,
 * so at 5% used about 74% of the week is projected unused at the pace end: room for a hire. A hire's daily part is
 * its part of the team's daily budget beside lead and bravo (weight 1 each) and alpha (3 queued p1 tasks, weighed by
 * its top one alone: 5, T1588), so a hire takes 1 of 8, where the summed weights (alpha 15) gave it 1 of 18.
 */
const RESET = Date.parse('2030-01-14T01:00:00Z');
const TAB = '0000000a-0000-4000-8000-000000000001';
const HOUR_MS = 3_600_000;

function status(usedPct: number): string {
  return JSON.stringify({ session_id: TAB, cwd: APP, workspace: { current_dir: APP }, rate_limits: { seven_day: { used_percentage: usedPct, resets_at: RESET / 1000 } } });
}

function lead(kit: CliHarness, ...argv: string[]): Promise<CliResult> {
  return kit.run([...argv, '--session', 'lead']);
}

async function finish(kit: CliHarness, id: string, session: string): Promise<void> {
  ok(await kit.run(['set', id, '--status', 'done', '--note', 'shipped', '--evidence', 'abc1234', '--skill', 'none', '--followups', 'none', '--session', session]));
}

/** alpha finished T1-T7 today, a pace of 1 a day, and holds T8-T10, p1 and due by the end of tomorrow. */
async function behindTeam(budget: JsonRecord = {}): Promise<CliHarness> {
  const kit = new CliHarness({ ...TEAM, budget: { enabled: true, weeklyLimitW: 1_000_000_000, ...budget }, hiring: { policy: 'lead' } });
  ok(await kit.run(['statusline'], { stdin: status(5) }));
  for (let task = 1; task <= 10; task += 1) {
    const due = task > 7 ? ['--due', '2030-01-09'] : [];
    ok(await lead(kit, 'add', '--owner', 'alpha', '--title', `job ${task}`, '--description', 'the job', '--priority', 'p1', ...due));
  }
  for (let task = 1; task <= 7; task += 1) {
    await finish(kit, `T${task}`, 'alpha');
  }
  return kit;
}

async function hireLines(kit: CliHarness): Promise<string[]> {
  return ok(await lead(kit, 'check', '--all')).stdout.filter((line) => line.startsWith('HIRE'));
}

describe('check SCALE-OUT', () => {
  it('flags an area behind its dated work, gives the slice to the hire made for it, then keeps the hire once idle', async () => {
    const kit = await behindTeam();
    const [heading, flag] = await hireLines(kit);
    assert.equal(heading, 'HIRES 1 flag(s)');
    assert.match(flag ?? '', /^HIRE SCALE-OUT \(3 due by 01-09, its pace finishes 1\.6 by then \(7 done in 7 d\); slice T9 T10, due by 01-09, about 4\.2% of the week, 7\d\.\d% spare\) alpha: the lead hires for it/);
    assert.match(ok(await kit.run(['start', '--session', 'alpha'])).stdout.join('\n'), /HIRE SCALE-OUT .* alpha:/);
    assert.doesNotMatch(ok(await kit.run(['start', '--session', 'bravo'])).stdout.join('\n'), /HIRE /);

    ok(await lead(kit, 'hire', 'helper', '--scope', 'T9 T10', '--reason', 'SCALE-OUT', '--yes'));
    kit.clock.advance(5 * HOUR_MS);
    const [, move, ...rest] = await hireLines(kit);
    assert.match(move ?? '', /^HIRE SCALE-OUT .* alpha: the lead moves the slice to helper, an idle hire \(teamrig update <id> --owner helper, for each\)$/);
    assert.deepEqual(rest, [], 'no other hire flag');

    ok(await lead(kit, 'update', 'T9', '--owner', 'helper'));
    ok(await lead(kit, 'update', 'T10', '--owner', 'helper'));
    assert.deepEqual(await hireLines(kit), [], 'the slice moved: alpha fits, and helper has work');
    await finish(kit, 'T9', 'helper');
    await finish(kit, 'T10', 'helper');
    kit.clock.advance(5 * HOUR_MS);
    assert.deepEqual(await hireLines(kit), [], 'the idle hire stays on the team: no RETIRE-DUE');
  });

  it("prices the slice at a new hire's part of the team's daily budget, smaller beside a session of a bigger share", async () => {
    // alpha's share of 3 makes it weigh 15 (its top p1 task's 5, three times): a hire takes 1 of 18, not the 1 of 8 above.
    const kit = await behindTeam({ sessions: { alpha: { share: 3 } } });
    assert.match((await hireLines(kit))[1] ?? '', /slice T9 T10, due by 01-09, about 1\.9% of the week, 7\d\.\d% spare\) alpha:/);
  });

  it("weighs the slice against the team's part of the account's spare when another team shares the account", async () => {
    const kit = await behindTeam();
    // A second team of three sessions weighs 3 beside the app team's 7 (lead 1, bravo 1, alpha's top p1 task 5): the app
    // team's part is 7/10 of the 74.2% spare.
    await kit.files.write(teamConfigOf('web'), formatConfig({ configVersion: 1, sessions: ['lead', 'front', 'back'], roles: { lead: 'lead' } }));
    const lines = await hireLines(kit);
    assert.ok(lines.some((line) => /^HIRE SCALE-OUT .*, 51\.9% spare\) alpha:/.test(line)), lines.join('\n'));
  });

  it('flags nothing when the week has no spare for the slice', async () => {
    const kit = await behindTeam();
    ok(await kit.run(['statusline'], { stdin: status(60) }));
    assert.deepEqual(await hireLines(kit), []);
  });
});
