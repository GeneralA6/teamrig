import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { APP, CliHarness, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { ok } from '../testing/hired-team.ts';
import { EXIT } from './runtime.ts';

/**
 * The harness clock is Tuesday 2030-01-08 10:00 UTC; the status line's week resets on Monday 2030-01-14 01:00
 * UTC, so it started Monday 01-07 01:00 and its pace ends Monday 01-14 00:00. burst.surplusHours 167 opens the
 * surplus window at once; at 5% used, about 74% of the week is projected unused at the pace end.
 */
const RESET = Date.parse('2030-01-14T01:00:00Z');
const BURSTS = join(TEAM_HOME, 'state', 'usage', 'bursts.jsonl');
const HIRES = join(TEAM_HOME, 'state', 'hires.jsonl');
const TAB = '0000000a-0000-4000-8000-000000000001';
const OWNER_OK = ['--approved-by', 'the owner'];

function config(extra: JsonRecord = {}): JsonRecord {
  return {
    ...TEAM,
    budget: { enabled: true, weeklyLimitW: 1_000_000_000 },
    burst: { surplusHours: 167 },
    hiring: { policy: 'owner' },
    launch: { lead: { model: 'opus', effort: 'high' } },
    ...extra,
  };
}

/** Claude Code's status input: the week `usedPct` used. */
function status(usedPct: number): string {
  return JSON.stringify({ session_id: TAB, cwd: APP, workspace: { current_dir: APP }, rate_limits: { seven_day: { used_percentage: usedPct, resets_at: RESET / 1000 } } });
}

/** A team whose week is `usedPct` used, by the status line's reading. */
async function team(extra: JsonRecord = {}, usedPct = 5): Promise<CliHarness> {
  const kit = new CliHarness(config(extra));
  ok(await kit.run(['statusline'], { stdin: status(usedPct) }));
  return kit;
}

function lead(kit: CliHarness, ...argv: string[]): Promise<CliResult> {
  return kit.run([...argv, '--session', 'lead']);
}

function refusal(result: CliResult): string {
  assert.equal(result.code, EXIT.refused, [...result.stdout, ...result.stderr].join('\n'));
  return result.stdout.join('\n');
}

function usage(result: CliResult): string {
  assert.equal(result.code, EXIT.usage, [...result.stdout, ...result.stderr].join('\n'));
  return result.stderr.join('\n');
}

async function addTask(kit: CliHarness, owner: string): Promise<void> {
  ok(await lead(kit, 'add', '--owner', owner, '--title', `work for ${owner}`, '--description', 'the job', '--priority', 'p1'));
}

describe('burst', () => {
  it('shows the policy, the week, its surplus and what to run, and writes nothing', async () => {
    const kit = await team();
    assert.deepEqual(ok(await kit.run(['burst'])).stdout, [
      'POLICY burst.policy owner: the lead starts one once the owner approves it (--approved-by)',
      'WEEK 5.0% of the week used; the pace ends Mon 01-14 00:00 UTC, the reset is Mon 01-14 01:00 UTC',
      'SURPLUS about 74.2% of the week projected unused at the pace end (budget.targetPct 99.5%): worth a surplus burst now',
      'BURST none yet',
      'NEXT preview a surplus burst: teamrig burst start surplus --reason "<why>" --approved-by "<who>"',
    ]);
    assert.equal(kit.files.get(BURSTS), undefined);
  });

  it("prints the pace end and the reset on the team's clock", async () => {
    const kit = await team();
    const [, week] = ok(await kit.run(['burst'], { timeZone: 'Asia/Jerusalem' })).stdout;
    assert.equal(week, 'WEEK 5.0% of the week used; the pace ends Mon 01-14 02:00 IST, the reset is Mon 01-14 03:00 IST');
  });

  it('says when the surplus window opens, when the spare is too small, and when the week is unknown', async () => {
    const shut = await team({ burst: { surplusHours: 48 } });
    assert.match(ok(await shut.run(['burst'])).stdout.join('\n'), /SURPLUS .*; a surplus burst may start from Sat 01-12 01:00 UTC \(burst\.surplusHours 48 before the reset\)/);
    assert.match(ok(await shut.run(['burst'])).stdout.join('\n'), /NEXT for work due by a time, preview a deadline burst: teamrig burst start deadline --task <ids> --by <time> --stop-pct <n>/);
    const spent = await team({}, 30);
    assert.match(ok(await spent.run(['burst'])).stdout.join('\n'), /SURPLUS about 0\.0% .*: below burst\.minSparePct \(5\.0%\), so no surplus burst/);
    const unknown = new CliHarness(config({ budget: { enabled: true } }));
    assert.match(ok(await unknown.run(['burst'])).stdout.join('\n'), /WEEK the week's use or reset is unknown/);
    const off = await team({ burst: { policy: 'off', surplusHours: 167 } });
    const lines = ok(await off.run(['burst'])).stdout;
    assert.equal(lines[0], 'POLICY burst.policy off: the team takes no bursts');
    assert.ok(!lines.some((line) => line.startsWith('NEXT')), lines.join('\n'));
  });
});

describe('burst start', () => {
  it('previews a surplus burst for the whole team, then starts it with --yes', async () => {
    const kit = await team();
    const preview = ok(await lead(kit, 'burst', 'start', 'surplus', '--reason', 'week-end surplus', ...OWNER_OK));
    assert.deepEqual(preview.stdout, [
      'PREVIEW a surplus burst until Mon 01-14 00:00 UTC or 99.5% of the week: app-lead, app-alpha, app-bravo each have a daily budget of at least 5.6%, up to 3 helpers at once. Nothing written (add --yes to write).',
      '  the week is at 5.0%; the burst may take it to 99.5% by Mon 01-14 00:00 UTC (budget.targetPct 99.5%)',
    ]);
    assert.equal(kit.files.get(BURSTS), undefined);
    const started = ok(await lead(kit, 'burst', 'start', 'surplus', '--reason', 'week-end surplus', ...OWNER_OK, '--hires', '1', '--yes'));
    assert.match(started.stdout[0] ?? '', /^STARTED a surplus burst .* up to 3 helpers at once, 1 hire for the team\.$/);
    assert.match(started.stdout[2] ?? '', /^NEXT its sessions read it at their next turn; end it early: teamrig burst end --reason "<why>"; hire for it: teamrig hire <id> --burst/);
    const logged: unknown = JSON.parse(kit.files.get(BURSTS) ?? '');
    assert.ok(typeof logged === 'object' && logged !== null && 'approvedBy' in logged && logged.approvedBy === 'the owner');
    const shown = ok(await kit.run(['burst'])).stdout;
    assert.match(shown.join('\n'), /BURST in force: a surplus burst/);
    assert.match(shown.join('\n'), / {2}started Tue 01-08 10:00 UTC by app-lead, approved by the owner: week-end surplus/);
    assert.equal(shown.at(-1), 'NEXT end it early: teamrig burst end --reason "<why>"');
    assert.match(ok(await kit.run(['budget'])).stdout.join('\n'), /Budget: the lead started a surplus burst .*: app-lead, app-alpha, app-bravo each have a daily budget of at least/);
    assert.match(refusal(await lead(kit, 'burst', 'start', 'surplus', '--reason', 'again', ...OWNER_OK)), /a surplus burst runs until .*; end it first/);
  });

  it('reads the floor in force from the week now, not from its start', async () => {
    const kit = await team({ burst: { policy: 'lead', surplusHours: 167 } });
    ok(await lead(kit, 'burst', 'start', 'surplus', '--reason', 'week-end surplus', '--yes'));
    ok(await kit.run(['statusline'], { stdin: status(50) }));
    // 49.5% left over the 134 hours to the pace end is 8.9% a day, shared by three: the start's 5.6% would overspend.
    assert.match(ok(await kit.run(['burst'])).stdout.join('\n'), /BURST in force: a surplus burst .*: app-lead, app-alpha, app-bravo each have a daily budget of at least 3\.0%/);
    assert.match(ok(await kit.run(['budget'])).stdout.join('\n'), /Budget: the lead started a surplus burst .* each have a daily budget of at least 3\.0%/);
  });

  it("is the lead's, under burst.policy owner only with the owner's approval", async () => {
    const kit = await team();
    assert.match(refusal(await kit.run(['burst', 'start', 'surplus', '--reason', 'r', ...OWNER_OK, '--session', 'alpha'])), /only the lead \(app-lead\) starts a burst/);
    assert.match(refusal(await lead(kit, 'burst', 'start', 'surplus', '--reason', 'r')), /burst\.policy is owner: .* --approved-by "<who>"/);
    const byLead = await team({ burst: { policy: 'lead', surplusHours: 167 } });
    ok(await lead(byLead, 'burst', 'start', 'surplus', '--reason', 'r', '--yes'));
    const off = await team({ burst: { policy: 'off' } });
    assert.match(refusal(await lead(off, 'burst', 'start', 'surplus', '--reason', 'r', ...OWNER_OK)), /burst\.policy is off/);
  });

  it("starts a deadline burst on its tasks' owners, with its stop % and deadline", async () => {
    const kit = await team();
    await addTask(kit, 'alpha');
    const args = ['burst', 'start', 'deadline', '--task', 'T1', '--by', '2030-01-08 20:00', '--stop-pct', '40', '--reason', 'release', ...OWNER_OK];
    assert.equal(
      ok(await lead(kit, ...args)).stdout[0],
      "PREVIEW a deadline burst for T1 (due Tue 01-08 20:00 UTC) until Tue 01-08 20:00 UTC or 40.0% of the week: app-alpha's daily budget is at least 35.0%, up to 3 helpers at once. Nothing written (add --yes to write).",
    );
    assert.match(ok(await lead(kit, ...args, '--sessions', 'alpha,bravo')).stdout[0] ?? '', /app-alpha, app-bravo each have a daily budget of at least 17\.5%/);
    assert.match(refusal(await lead(kit, 'burst', 'start', 'deadline', '--task', 'T1', '--by', '20:00', '--reason', 'r', ...OWNER_OK)), /needs --stop-pct/);
  });

  it('refuses tasks that are not open or not there, and flags that do not fit', async () => {
    const kit = await team();
    await addTask(kit, 'alpha');
    ok(await kit.run(['set', 'T1', '--status', 'dropped', '--note', 'not needed', '--session', 'alpha']));
    const deadline = ['burst', 'start', 'deadline', '--by', '20:00', '--stop-pct', '40', '--reason', 'r', ...OWNER_OK];
    assert.match(refusal(await lead(kit, ...deadline, '--task', 'T1')), /T1 is dropped: a burst works on open tasks only/);
    assert.match(refusal(await lead(kit, ...deadline, '--task', 'T9')), /T9 is not a task of the team/);
    assert.match(usage(await lead(kit, 'burst', 'start', 'surplus', '--task', 'T1', '--reason', 'r')), /a surplus burst takes neither/);
    assert.match(usage(await lead(kit, 'burst', 'start', 'sprint', '--reason', 'r')), /"sprint" is not a burst kind: surplus or deadline/);
    assert.match(usage(await lead(kit, 'burst', 'start', 'surplus', '--reason', ' ')), /--reason needs a reason/);
    assert.match(usage(await lead(kit, 'burst', 'start', 'surplus', '--reason', 'r', '--helpers', '1.5')), /--helpers "1\.5" is not a whole number of 0 or more/);
    assert.match(usage(await lead(kit, 'burst', 'start', 'surplus', '--reason', 'r', '--hires', '-1')), /--hires "-1" is not a whole number/);
    assert.match(usage(await lead(kit, 'burst', 'start', 'deadline', '--task', 'T1', '--by', 'soon', '--stop-pct', '40', '--reason', 'r')), /--by "soon" is not HH:MM or YYYY-MM-DD HH:MM in UTC/);
    assert.match(refusal(await lead(kit, 'burst', 'start', 'surplus', '--reason', 'r', ...OWNER_OK, '--helpers', '9')), /--helpers 9 is above burst\.maxHelpers \(3\)/);
  });
});

describe('burst end', () => {
  it('ends the burst in force for the lead, and names its hires to retire', async () => {
    const kit = await team();
    assert.match(refusal(await lead(kit, 'burst', 'end', '--reason', 'r')), /no burst is in force: nothing to end/);
    ok(await lead(kit, 'burst', 'start', 'surplus', '--reason', 'surplus', ...OWNER_OK, '--hires', '1', '--yes'));
    ok(await lead(kit, 'hire', 'helper', '--scope', 'port the importer', '--reason', 'the burst', '--burst', '--yes'));
    assert.match(refusal(await kit.run(['burst', 'end', '--reason', 'r', '--session', 'alpha'])), /only the lead \(app-lead\) ends a burst/);
    assert.match(usage(await lead(kit, 'burst', 'end', '--reason', '')), /--reason needs a reason/);
    assert.deepEqual(ok(await lead(kit, 'burst', 'end', '--reason', 'the work is done')).stdout, [
      "ENDED the surplus burst started Tue 01-08 10:00 UTC: its sessions' daily budgets are the shared ones again",
      'NEXT retire its hires: teamrig retire helper',
    ]);
    assert.match(ok(await kit.run(['burst'])).stdout.join('\n'), /BURST none in force; the last, a surplus burst, started Tue 01-08 10:00 UTC \(surplus\)/);
  });
});

describe('hire --burst', () => {
  it("hires within the burst's hires, approved with the burst, and flags it RETIRE-DUE once the burst is over", async () => {
    const kit = await team();
    const job = ['--scope', 'port the importer', '--reason', 'the burst', '--burst'];
    assert.match(refusal(await lead(kit, 'hire', 'helper', ...job)), /no burst is in force: hire --burst hires for one \(teamrig burst\)/);
    ok(await lead(kit, 'burst', 'start', 'surplus', '--reason', 'surplus', ...OWNER_OK, '--hires', '1', '--yes'));
    assert.match(refusal(await lead(kit, 'hire', 'helper', ...job, '--model', 'haiku')), /a burst hire runs on the lead's model \(opus\), never another/);
    assert.match(refusal(await lead(kit, 'hire', 'helper', ...job, '--effort', 'medium')), /--effort medium is below the lead's high: a burst never lowers effort/);
    const hired = ok(await kit.run(['hire', 'helper', ...job, '--effort', 'xhigh', '--yes', '--session', 'lead'], { timeZone: 'Asia/Jerusalem' }));
    assert.match(hired.stdout[0] ?? '', /^HIRED helper .*, for the burst started Tue 01-08 12:00 IST; the old config is at/, "on the team's clock");
    const record: unknown = JSON.parse(kit.files.get(HIRES) ?? '');
    assert.ok(typeof record === 'object' && record !== null && 'burst' in record && 'approvedBy' in record);
    assert.deepEqual([record.burst, record.approvedBy], ['2030-01-08T10:00:00.000Z', 'the owner']);
    assert.match(refusal(await lead(kit, 'hire', 'second', ...job)), /the burst allows 1 hire, and 1 is on the team/);
    assert.match(ok(await kit.run(['burst'])).stdout.join('\n'), / {2}its hires: app-helper \(1 of 1\)/);
    await addTask(kit, 'helper');
    assert.doesNotMatch(ok(await lead(kit, 'check', '--all')).stdout.join('\n'), /HIRE RETIRE-DUE/);
    ok(await lead(kit, 'burst', 'end', '--reason', 'done'));
    assert.match(ok(await lead(kit, 'check', '--all')).stdout.join('\n'), /HIRE RETIRE-DUE \(the burst it was hired for is over\) helper: retire it/);
  });
});
