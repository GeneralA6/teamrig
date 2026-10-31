import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { MeterLog } from '../budget/calibration.ts';
import { recordConfigDir } from '../budget/config-dir.ts';
import { emptyPatterns } from '../budget/patterns.ts';
import { formatPeriod, parsePeriod } from '../budget/period.ts';
import { W_EXPLAINED } from '../budget/report.ts';
import { formatSnapshot, parseSnapshot, snapshotOfStatus, SNAPSHOT_PRUNED_FILE } from '../budget/snapshot.ts';
import { EMPTY_USAGE, UsageStore } from '../budget/store.ts';
import { WEEK_SUMMARY_FILE } from '../budget/week-summary.ts';
import { formatConfig } from '../config/load.ts';
import type { JsonRecord } from '../core/guards.ts';
import { MS_PER_DAY } from '../core/time.ts';
import { APP, CliHarness, KIT, TEAM, TEAM_HOME, USER_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { SUB_TEAMS, teamConfigOf, teamHomeOf } from '../testing/team-tree.ts';
import { promptLine, replyLine, transcript, type FixtureTool } from '../testing/transcript-lines.ts';
import type { RepoState } from '../push-guard/push.ts';
import { EXIT } from './runtime.ts';

/** The harness clock is Tuesday 2030-01-08 10:00 UTC; this week resets on Monday 2030-01-14 01:00 UTC. */
const RESET = Date.parse('2030-01-14T01:00:00Z');
const PROJECT = join(USER_HOME, '.claude', 'projects', 'app');
const ALPHA_TAB = '0000000a-0000-4000-8000-000000000001';
const BRAVO_TAB = '0000000b-0000-4000-8000-000000000002';
const STRANGER = '0000000c-0000-4000-8000-000000000003';
/** 1% of the week is 10M W. */
const LIMITED: JsonRecord = { ...TEAM, budget: { weeklyLimitW: 1_000_000_000 } };
const LIVE = join(KIT, 'usage', 'live');
const MARKS = join(TEAM_HOME, 'state', 'inbox-marks.jsonl');

function reply(id: string, input: number): string {
  return replyLine({ id, requestId: `q-${id}`, at: '2030-01-08T09:00:00.000Z', usage: { input } });
}

function titled(title: string): string {
  return JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: 'x' });
}

/**
 * Today: the tab titled alpha used 20M W in 2 calls, the tab bound to bravo by its inbox mark 5M W in
 * 1 call, and a tab outside the team 1M W in 1 call.
 */
function transcripts(at: number): MemoryTranscripts {
  const source = new MemoryTranscripts();
  source.set(join(PROJECT, `${ALPHA_TAB}.jsonl`), transcript([titled('alpha'), reply('a1', 15_000_000), reply('a2', 5_000_000)]), at);
  source.set(join(PROJECT, `${BRAVO_TAB}.jsonl`), transcript([reply('b1', 5_000_000)]), at);
  source.set(join(PROJECT, `${STRANGER}.jsonl`), transcript([titled('release checks'), reply('c1', 1_000_000)]), at);
  return source;
}

/** Claude Code's status input for a session in `cwd`: the week `usedPct` used, 30% unless named. */
function status(cwd: string, usedPct = 30): string {
  return JSON.stringify({
    session_id: ALPHA_TAB,
    cwd,
    workspace: { current_dir: cwd },
    model: { display_name: 'Opus 5.5' },
    rate_limits: { five_hour: { used_percentage: 6, resets_at: RESET / 1000 - 86_400 }, seven_day: { used_percentage: usedPct, resets_at: RESET / 1000 } },
  });
}

/** A status line snapshot a tab of another team saved in `dir`: the week `usedPct` used, read now. */
async function saveReading(kit: CliHarness, dir: string, session: string, usedPct: number): Promise<void> {
  const input = JSON.stringify({ session_id: session, cwd: APP, rate_limits: { seven_day: { used_percentage: usedPct, resets_at: RESET / 1000 } } });
  const snapshot = snapshotOfStatus(input, kit.clock.now());
  assert.ok(snapshot, input);
  await kit.files.write(join(dir, `${session}.json`), formatSnapshot(snapshot));
}

/** Records `team`'s sessions as starting on another Claude config dir than the harness runs in: another login. */
async function onAnotherLogin(kit: CliHarness, team: string): Promise<void> {
  await recordConfigDir(kit.files, join(teamHomeOf(team), 'state', 'usage', 'claude-config-dir.json'), join(USER_HOME, '.claude-work'));
}

interface World {
  readonly kit: CliHarness;
  readonly source: MemoryTranscripts;
  readonly run: (argv: readonly string[], extra?: RunOptions) => Promise<CliResult>;
}

async function world(config: JsonRecord = LIMITED, withStatus = true): Promise<World> {
  const kit = new CliHarness(config);
  const source = transcripts(kit.clock.now());
  await kit.files.append(
    MARKS,
    `${JSON.stringify({ v: 1, area: 'bravo', line: 0, at: '2030-01-08T08:00:00.000Z', claudeSession: BRAVO_TAB, lastLineHash: null })}\n`,
  );
  const run = (argv: readonly string[], extra: RunOptions = {}): Promise<CliResult> => kit.run(argv, { transcripts: source, ...extra });
  if (withStatus) {
    const saved = await run(['statusline'], { stdin: status(APP) });
    assert.equal(saved.code, EXIT.ok, saved.stderr.join('\n'));
  }
  return { kit, source, run };
}

function ok(result: CliResult): readonly string[] {
  assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
  return result.stdout;
}

function usageError(result: CliResult, message: RegExp): void {
  assert.equal(result.code, EXIT.usage);
  assert.match(result.stderr.join('\n'), message);
}

const OUTSIDE_LINE =
  'Not on the team: 1 Claude Code session (titled release checks), 1.00M W today. ' +
  'A tab counts for a session once it runs teamrig inbox read --session <id> or is named after it.';

describe('teamrig budget', () => {
  it("shows the week from the status line, the team's and each session's use today against their budgets, and use outside the team", async () => {
    const { run } = await world();
    assert.deepEqual(ok(await run(['budget'])), [
      'Week: 30.0% used at 10:00 UTC (status line); the pace line is at 19.7%: 10.3 points ahead. Resets Mon 01-14 01:00 UTC.',
      'Today (UTC day), used and daily budget in % of the week:',
      '  session     used  budget       W  calls',
      '  the team    2.5%   12.4%  25.00M      3',
      '  app-alpha   2.0%    4.1%  20.00M      2',
      '  app-bravo  0.50%    4.1%   5.00M      1',
      OUTSIDE_LINE,
      W_EXPLAINED,
    ]);
    assert.deepEqual(ok(await run(['budget', '--all'])).slice(6, 7), ['  No use today: app-lead.']);
  });

  it("gives the team its part of the account's daily budget beside the other teams on the account, and its sessions theirs of it", async () => {
    const { kit, run } = await world();
    await kit.files.write(teamConfigOf('web'), formatConfig({ configVersion: 1, sessions: ['lead', 'front', 'back'], roles: { lead: 'lead' } }));
    assert.deepEqual(ok(await run(['budget'])).slice(3, 6), [
      '  the team    2.5%    6.2%  25.00M      3',
      '  app-alpha   2.0%    2.1%  20.00M      2',
      '  app-bravo  0.50%    2.1%   5.00M      1',
    ]);
  });

  it('leaves a team on another Claude account out of the split', async () => {
    const { kit, run } = await world();
    await kit.files.write(teamConfigOf('web'), formatConfig({ configVersion: 1, sessions: ['lead', 'front', 'back'], roles: { lead: 'lead' }, budget: { account: 'work' } }));
    await onAnotherLogin(kit, 'web');
    assert.deepEqual(ok(await run(['budget'])).slice(3, 6), [
      '  the team    2.5%   12.4%  25.00M      3',
      '  app-alpha   2.0%    4.1%  20.00M      2',
      '  app-bravo  0.50%    4.1%   5.00M      1',
    ]);
  });

  it('leaves out a team that names no account but whose sessions start on another Claude config dir, another login', async () => {
    const { kit, run } = await world();
    await kit.files.write(teamConfigOf('web'), formatConfig({ configVersion: 1, sessions: ['lead', 'front', 'back'], roles: { lead: 'lead' } }));
    await onAnotherLogin(kit, 'web');
    assert.deepEqual(ok(await run(['budget'])).slice(3, 4), ['  the team    2.5%   12.4%  25.00M      3']);
  });

  it('splits with a team that names no account on the login of the one that names it', async () => {
    const { kit, run } = await world({ ...TEAM, budget: { weeklyLimitW: 1_000_000_000, account: 'work' } });
    await kit.files.write(teamConfigOf('web'), formatConfig({ configVersion: 1, sessions: ['lead', 'front', 'back'], roles: { lead: 'lead' } }));
    await recordConfigDir(kit.files, join(teamHomeOf('web'), 'state', 'usage', 'claude-config-dir.json'), join(USER_HOME, '.claude'));
    assert.deepEqual(ok(await run(['budget'])).slice(3, 4), ['  the team    2.5%    6.2%  25.00M      3']);
  });

  it('reads the week from the newest snapshot of any team on the account, never of a team on another account', async () => {
    const { kit, run } = await world();
    const webLive = join('/', 'web-live');
    const opsLive = join('/', 'ops-live');
    await kit.files.write(teamConfigOf('web'), formatConfig({ configVersion: 1, sessions: ['lead', 'front', 'back'], roles: { lead: 'lead' }, budget: { statusSnapshotDir: webLive } }));
    await kit.files.write(
      teamConfigOf('ops'),
      formatConfig({ configVersion: 1, sessions: ['lead', 'front', 'back'], roles: { lead: 'lead' }, budget: { account: 'work', statusSnapshotDir: opsLive } }),
    );
    await onAnotherLogin(kit, 'ops');
    kit.clock.advance(3_600_000);
    await saveReading(kit, webLive, BRAVO_TAB, 45);
    await saveReading(kit, opsLive, STRANGER, 80);
    assert.match(ok(await run(['budget']))[0] ?? '', /^Week: 45\.0% used at 11:00 UTC \(status line\)/);
  });

  it('keeps what it measured, so a second run reads only what is new', async () => {
    const { run, source } = await world();
    const first = ok(await run(['budget']));
    const read = source.bytesRead;
    assert.deepEqual(ok(await run(['budget'])), first);
    assert.ok(source.bytesRead - read < read / 2, `${source.bytesRead - read} of ${read} bytes read again`);
  });

  it("shows one session's use by day", async () => {
    const { run } = await world();
    assert.deepEqual(ok(await run(['budget', 'alpha'])), [
      'app-alpha (alpha), by UTC day:',
      '  2030-01-08  20.00M W in 2 calls, 2.0% of the week',
      'Its daily budget today is 4.1% of the week.',
      W_EXPLAINED,
    ]);
    usageError(await run(['budget', 'alpha', 'bravo']), /unexpected "bravo"/);
    assert.equal((await run(['budget', 'nobody'])).code, EXIT.refused);
  });

  it('tables the loop patterns of every session, or of one, over the last days', async () => {
    const { run } = await world();
    const every = ok(await run(['budget', '--loops']));
    assert.equal(every[0], 'Loop patterns, every session, outside the team too: count, then W (UTC days)');
    assert.match(every[1] ?? '', /^ +01-08$/);
    assert.match(every.at(-2) ?? '', /^all calls +4 26\.00M$/);
    assert.equal(every.at(-1), 'Left out, nothing metered: 01-05, 01-06, 01-07 (add --day 2030-01-05 to read one).');
    assert.equal(every.length, 13);
    const alpha = ok(await run(['budget', 'alpha', '--loops', '--all']));
    assert.equal(alpha[0], 'Loop patterns, app-alpha: count, then W (UTC days)');
    assert.equal((alpha[1] ?? '').trim(), '01-08');
    assert.match(alpha.at(-2) ?? '', / 2 20\.00M$/);
    assert.match(alpha.at(-1) ?? '', /^Left out, nothing metered: 01-01, .*, 01-07 \(add --day 2030-01-01 to read one\)\.$/);
  });

  it('tables what started the turns, cold calls and compactions, one table at a time', async () => {
    const { run } = await world();
    const every = ok(await run(['budget', '--burn']));
    assert.equal(every[0], 'Burn, every session, outside the team too: count, then W (UTC days)');
    assert.match(every.find((line) => line.startsWith('all calls')) ?? '', /^all calls +4 26\.00M$/);
    assert.match(every.find((line) => line.startsWith('not sorted')) ?? '', / 0$/);
    usageError(await run(['budget', '--loops', '--burn']), /--loops, --burn and --misses are three tables: give one/);
  });

  it('tables the rule misses of each session that made a call, or of one session by day', async () => {
    const { run } = await world();
    const every = ok(await run(['budget', '--misses']));
    assert.equal(every[0], 'Rule misses per session, misses/chances, 2030-01-05 to 2030-01-08 (UTC)');
    assert.deepEqual(every.slice(2, 4).map((line) => line.split(' ')[0]), ['app-alpha', 'app-bravo']);
    assert.match(every[2] ?? '', / 2\/2$/);
    assert.equal(every.length, 5);
    const alpha = ok(await run(['budget', 'alpha', '--misses']));
    assert.equal(alpha[0], 'Rule misses, app-alpha: misses/chances (UTC days)');
    assert.match(alpha.find((line) => line.startsWith('calls read')) ?? '', / 2\/2$/);
    usageError(await run(['budget', '--burn', '--misses']), /three tables: give one/);
  });

  it("meters a subagent's W at budget.subagentWeight", async () => {
    const { kit, source, run } = await world({ ...TEAM, budget: { weeklyLimitW: 1_000_000_000, subagentWeight: 3 } });
    source.set(join(PROJECT, BRAVO_TAB, 'subagents', 'agent-1.jsonl'), transcript([reply('s1', 1_000_000)]), kit.clock.now());
    assert.ok(ok(await run(['budget'])).some((line) => /^ {2}app-bravo +0\.80% +4\.1% +8\.00M +2$/.test(line)));
  });

  it("shows each session's W on a task, an open turn's share included, and today's share any task got", async () => {
    const { kit, source, run } = await world();
    const bash = (id: string, command: string): FixtureTool => ({ id, name: 'Bash', command });
    source.append(
      join(PROJECT, `${ALPHA_TAB}.jsonl`),
      transcript([
        promptLine('2030-01-08T09:30:00.000Z'),
        replyLine({ id: 'a3', requestId: 'q-a3', at: '2030-01-08T09:30:00.000Z', usage: { input: 4_000_000 }, tools: [bash('b1', 'teamrig set T7 && git -C .worktrees/t8-x log')] }),
        promptLine('2030-01-08T09:40:00.000Z'),
        replyLine({ id: 'a4', requestId: 'q-a4', at: '2030-01-08T09:40:00.000Z', usage: { input: 1_000_000 }, tools: [bash('b2', 'teamrig show T7')] }),
      ]),
      kit.clock.now(),
    );
    // a3's 4M splits over T7 and T8 at the next prompt; a4's 1M is held for T7 alone. 5M of today's 31M named a task.
    const today = 'Today turns that named a task spent 16.1% of all metered W; the rest went to turns that named none and to helpers.';
    assert.deepEqual(ok(await run(['budget', '--task', 'T7'])), [
      "T7: 3.00M W, 0.30% of the week, in the 8 UTC days the meter keeps, open turns' share included:",
      '  app-alpha  3.00M W  0.30%  01-08 3.00M',
      today,
      W_EXPLAINED,
    ]);
    assert.deepEqual(ok(await run(['budget', '--task', 'T9'])), [
      'T9: no W in the 8 UTC days the meter keeps; a turn counts for it when a call names it: T9 in a command, t9- in a branch or path.',
      today,
      W_EXPLAINED,
    ]);
    usageError(await run(['budget', 'alpha', '--task', 'T7']), /--task reads alone/);
    usageError(await run(['budget', '--task', 'T7', '--loops']), /--task reads alone/);
    usageError(await run(['budget', '--task', '734']), /--task "734" is not a task id such as T734/);
  });

  it('recounts a past day from the transcripts, writing nothing', async () => {
    const { kit, run } = await world();
    const before = kit.files.paths().map((path) => [path, kit.files.get(path)]);
    assert.deepEqual(ok(await run(['budget', '--day', '2030-01-08'])), [
      '2030-01-08 (UTC), recounted from the transcripts; nothing was written.',
      'The team used 2.5% of the week that day. 25.00M W in 3 calls.',
      'app-alpha used 2.0% of the week that day. 20.00M W in 2 calls.',
      'app-bravo used 0.50% of the week that day. 5.00M W in 1 call.',
      'Not on the team: 1 Claude Code session (titled release checks), 1.00M W in 1 call.',
      W_EXPLAINED,
    ]);
    assert.deepEqual(ok(await run(['budget', '--day', '2030-01-08', '--all'])).slice(4, 5), ['No use that day: app-lead.']);
    assert.match(ok(await run(['budget', '--loops', '--day', '2030-01-07'])).at(-1) ?? '', /^all calls +0 0$/);
    assert.deepEqual(kit.files.paths().map((path) => [path, kit.files.get(path)]), before);
    usageError(await run(['budget', '--day', '2030-01-09']), /--day 2030-01-09 has not begun/);
    usageError(await run(['budget', '--day', 'tuesday']), /--day "tuesday" is not a YYYY-MM-DD day/);
  });

  it('shows plain W with no status line and no weekly limit', async () => {
    const { run } = await world(TEAM, false);
    const lines = ok(await run(['budget']));
    assert.equal(lines[0], 'Week: its use is unknown: no status line reading (run teamrig statusline install) and no budget.weeklyLimitW.');
    assert.deepEqual(lines.slice(1, 4), ['Today (UTC day):', '  session         W  calls', '  the team   25.00M      3']);
  });
});

describe('teamrig budget lift', () => {
  const LIFT = ['budget', 'lift', 'alpha', '--part', '50', '--stop-pct', '97', '--reason', 'release'];

  it("lifts a session to a part of the team's daily budget for today, logged and shown by budget", async () => {
    const { kit, run } = await world();
    assert.deepEqual(ok(await run([...LIFT, '--session', 'lead'])), [
      "LIFTED app-alpha to 50.0% of the team's daily budget (6.2% of the week now) today until 00:00 UTC (the end of the budget day) or 97.0% of the week, whichever comes first; quiet hours do not apply to it.",
    ]);
    assert.equal((kit.files.get(join(TEAM_HOME, 'state', 'usage', 'lifts.jsonl')) ?? '').split('\n').filter((line) => line !== '').length, 1);
    const lines = ok(await run(['budget']));
    // Half the team's 12.4% to alpha; the other half split between lead and bravo.
    assert.match(lines[4] ?? '', /^ {2}app-alpha +2\.0% +6\.2% +\(lifted\) +20\.00M +2$/);
    assert.match(lines[5] ?? '', /^ {2}app-bravo +0\.50% +3\.1% +5\.00M +1$/);
    assert.match(lines[6] ?? '', /^Lifts, today only: a part of the team's daily budget, the share of the week it comes to now beside it, /);
    assert.match(lines[8] ?? '', /^ {2}app-alpha +50\.0% +6\.2% +00:00 UTC +97\.0%$/);
    assert.equal(lines[9], '  00:00 UTC is the end of the budget day.');
    assert.deepEqual(ok(await run([...LIFT, '--until', '18:00', '--session', 'lead'])), [
      "LIFTED app-alpha to 50.0% of the team's daily budget (6.2% of the week now) today until 18:00 UTC or 97.0% of the week, whichever comes first; quiet hours do not apply to it.",
    ]);
  });

  it("lifts a sub-lead's member to a part of its group's daily budget, which budget names", async () => {
    const { run } = await world({ ...LIMITED, leads: { bravo: ['alpha'] } });
    // Bravo's group of 2 gets 2/3 of the team's 12.4%, half of that is 4.1% of the week.
    const LIFTED =
      "app-alpha to 50.0% of app-bravo's group's daily budget (4.1% of the week now) today until 00:00 UTC (the end of the budget day) or 97.0% of the week, whichever comes first; quiet hours do not apply to it.";
    assert.deepEqual(ok(await run([...LIFT, '--session', 'lead'])), [`LIFTED ${LIFTED}`]);
    assert.ok(ok(await run(['budget', 'alpha'])).includes(`Budget: app-lead lifted ${LIFTED}`));
  });

  it("refuses lifts that would give more than the team's daily budget, the session's own older lift aside", async () => {
    const { run } = await world();
    ok(await run([...LIFT, '--session', 'lead']));
    const refused = await run(['budget', 'lift', 'bravo', '--part', '60', '--stop-pct', '97', '--reason', 'release', '--session', 'lead']);
    assert.equal(refused.code, EXIT.refused);
    assert.match(refused.stdout.join('\n'), /other lifts in force give 50\.0% of the team's daily budget, so --part 60 would give more than all of it/);
    ok(await run(['budget', 'lift', 'alpha', '--part', '90', '--stop-pct', '97', '--reason', 'release', '--session', 'lead']));
  });

  it('splits the team budget by each session\'s queued work in the register', async () => {
    const { run } = await world();
    const added = await run(['add', '--title', 'Ship the release', '--description', 'what and why', '--priority', 'p1', '--owner', 'alpha', '--session', 'lead']);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    const lines = ok(await run(['budget']));
    // alpha's p1 task weighs 5, lead and bravo with none 1 each: 12.4% × 5/7 and × 1/7.
    assert.match(lines[4] ?? '', /^ {2}app-alpha +2\.0% +8\.9% +20\.00M +2$/);
    assert.match(lines[5] ?? '', /^ {2}app-bravo +0\.50% +1\.8% +5\.00M +1$/);
  });

  it('gives no part to a session a short day does not fund, with budget.pauseByPriority on', async () => {
    const { run } = await world({ ...LIMITED, budget: { weeklyLimitW: 1_000_000_000, pauseByPriority: true } });
    ok(await run(['add', '--title', 'Stop the outage', '--description', 'what and why', '--priority', 'p0', '--owner', 'alpha', '--session', 'lead']));
    const lines = ok(await run(['budget']));
    // At 30% the day has 12.4% of the 14.3% the pace line plans: of the 8 weights' 6.96, the lead's 1 first, then 5.96 of alpha's p0 6, none for idle bravo.
    assert.match(lines[4] ?? '', /^ {2}app-alpha +2\.0% +10\.7% +20\.00M +2$/);
    assert.match(lines[5] ?? '', /^ {2}app-bravo +0\.50% +0\.0% +\(paused\) +5\.00M +1$/);
    assert.ok(lines.includes("Paused today, funded by priority as the week's use is past its pace line (budget.pauseByPriority): app-bravo."), lines.join('\n'));
  });

  it("reads --until on the team's clock, and prints the lift's end and the week on it", async () => {
    const { run } = await world();
    const JERUSALEM = { timeZone: 'Asia/Jerusalem' };
    assert.deepEqual(ok(await run([...LIFT, '--until', '14:00', '--session', 'lead'], JERUSALEM)), [
      "LIFTED app-alpha to 50.0% of the team's daily budget (6.2% of the week now) today until 14:00 IST or 97.0% of the week, whichever comes first; quiet hours do not apply to it.",
    ]);
    const lines = ok(await run(['budget'], JERUSALEM));
    assert.match(lines[0] ?? '', / Resets \w{3} \d{2}-\d{2} \d{2}:\d{2} IST\.$/);
    assert.match(lines[8] ?? '', /^ {2}app-alpha +50\.0% +6\.2% +14:00 IST +97\.0%$/);
    assert.ok(!lines.some((line) => line.includes('end of the budget day')), lines.join('\n'));
    const passed = await run([...LIFT, '--until', '11:00', '--session', 'lead'], JERUSALEM);
    assert.equal(passed.code, EXIT.refused);
    assert.match(passed.stdout.join('\n'), /--until 2030-01-08 11:00 IST has passed/);
  });

  it('is refused to a session that leads none, naming who lifts', async () => {
    const { kit, run } = await world();
    const refused = await run([...LIFT, '--session', 'bravo']);
    assert.equal(refused.code, EXIT.refused);
    assert.deepEqual(refused.stdout, ["REFUSED app-alpha's budget is lifted only by app-lead"]);
    assert.equal(kit.files.get(join(TEAM_HOME, 'state', 'usage', 'lifts.jsonl')), undefined);
  });

  describe('in a lead tree', () => {
    /** Bravo leads alpha; the lead leads bravo's group and itself. */
    const TREE: JsonRecord = { ...LIMITED, leads: { bravo: ['alpha'] } };
    const lifted = (who: string, parent: string, week: string, quiet = '; quiet hours do not apply to it'): string =>
      `LIFTED ${who} to 50.0% of ${parent} (${week} of the week now) today until 00:00 UTC (the end of the budget day) or 97.0% of the week, whichever comes first${quiet}.`;

    it('lets a sub-lead lift its members and its own session, parts of its group\'s budget', async () => {
      const { run } = await world(TREE);
      // Half of the group's 2/3 of the team's 12.4%.
      assert.deepEqual(ok(await run([...LIFT, '--session', 'bravo'])), [lifted('app-alpha', "app-bravo's group's daily budget", '4.1%')]);
      assert.deepEqual(ok(await run(['budget', 'lift', 'bravo', '--part', '50', '--stop-pct', '97', '--reason', 'release', '--session', 'bravo'])), [
        lifted('app-bravo', "app-bravo's group's daily budget", '4.1%'),
      ]);
    });

    it('refuses a sub-lead a session outside its group, and a session that leads none a sub-lead', async () => {
      const { run } = await world(TREE);
      const outside = await run(['budget', 'lift', 'lead', '--part', '50', '--stop-pct', '97', '--reason', 'release', '--session', 'bravo']);
      assert.equal(outside.code, EXIT.refused);
      assert.deepEqual(outside.stdout, ["REFUSED app-lead's budget is lifted only by app-lead"]);
      const member = await run(['budget', 'lift', 'bravo', '--part', '50', '--stop-pct', '97', '--reason', 'release', '--session', 'alpha']);
      assert.deepEqual(member.stdout, ["REFUSED app-bravo's budget is lifted only by app-bravo or app-lead"]);
    });

    it("lets the lead lift a sub-lead's group to a part of the team's budget, which exempts no quiet hours", async () => {
      const { run } = await world(TREE);
      assert.deepEqual(ok(await run(['budget', 'lift', 'bravo', '--group', '--part', '50', '--stop-pct', '97', '--reason', 'release', '--session', 'lead'])), [
        lifted("app-bravo's group", "the team's daily budget", '6.2%', ''),
      ]);
    });

    it("shows the group's row after the team's, and its lift first in the lifts block, each lift naming its parent", async () => {
      const { run } = await world(TREE);
      ok(await run(['budget', 'lift', 'bravo', '--group', '--part', '50', '--stop-pct', '97', '--reason', 'release', '--session', 'lead']));
      ok(await run([...LIFT, '--session', 'bravo']));
      const lines = ok(await run(['budget']));
      // The lead gave bravo's group half the team's 12.4%, and bravo gave alpha half of that; at 10M W per percent.
      assert.match(lines[4] ?? '', /^ {2}group app-bravo \(2\) +2\.5% +6\.2% +\(lifted\) +25\.00M +3$/);
      assert.match(lines[5] ?? '', /^ {2}app-alpha +2\.0% +3\.1% +\(lifted\) +20\.00M +2$/);
      const heading = lines.findIndex((line) => line.startsWith("Lifts, today only: a part of the team's or a group's daily budget, the share of the week it comes to now beside it, "));
      assert.match(lines[heading + 2] ?? '', /^ {2}group app-bravo +the team +50\.0% +6\.2% +00:00 UTC +97\.0%$/);
      assert.match(lines[heading + 3] ?? '', /^ {2}app-alpha +group app-bravo +50\.0% +3\.1% +00:00 UTC +97\.0%$/);
    });

    it("refuses --group on a session that leads no group, on the lead, and to the sub-lead itself", async () => {
      const { run } = await world(TREE);
      const group = (target: string, by: string): Promise<CliResult> =>
        run(['budget', 'lift', target, '--group', '--part', '50', '--stop-pct', '97', '--reason', 'release', '--session', by]);
      assert.deepEqual((await group('alpha', 'lead')).stdout, ["REFUSED --group lifts a sub-lead's group, and app-alpha leads none"]);
      assert.deepEqual((await group('lead', 'lead')).stdout, ["REFUSED --group lifts a sub-lead's group; app-lead is the lead, whose group is the whole team"]);
      const own = await group('bravo', 'bravo');
      assert.equal(own.code, EXIT.refused);
      assert.deepEqual(own.stdout, ["REFUSED app-bravo's group's budget is lifted only by app-lead"]);
    });

    it("names the group's budget and use today, and the group lift its leader can give, when a lift is too big for it", async () => {
      const { run } = await world(TREE);
      ok(await run(['budget', 'lift', 'alpha', '--part', '60', '--stop-pct', '97', '--reason', 'release', '--session', 'bravo']));
      const refused = await run(['budget', 'lift', 'bravo', '--part', '60', '--stop-pct', '97', '--reason', 'release', '--session', 'bravo']);
      assert.equal(refused.code, EXIT.refused);
      // Alpha's 20M W and bravo's 5M W today, at 10M W per percent.
      assert.match(
        refused.stdout.join('\n'),
        /other lifts in force give 60\.0% of app-bravo's group's daily budget, so --part 60 would give more than all of it; the most this lift may give is 40\.0%\. app-bravo's group gets \d+\.\d% of the week today and has used 2\.5%; app-lead can lift it: `teamrig budget lift app-bravo --group --part <pct> --stop-pct <n> --reason "<why>"`$/,
      );
    });
  });

  describe('of a session of a team under the own', () => {
    const LIFTS = join(TEAM_HOME, 'state', 'usage', 'lifts.jsonl');
    const crossLift = (target: string, part: string, by = 'lead'): readonly string[] => [
      'budget', 'lift', target, '--part', part, '--stop-pct', '97', '--reason', 'release', '--session', by,
    ];
    const lifted = (who: string, part: string, week: string): string =>
      `LIFTED ${who} to ${part}% of team app's daily budget (${week}% of the week now) on top of its own budget today until 00:00 UTC (the end of the budget day) or 97.0% of the week, whichever comes first.`;

    /** The harness's team as `app`, the root of SUB_TEAMS, with `web`'s config replaced by `web` when given. */
    async function tree(web?: JsonRecord): Promise<World> {
      const team = await world({ ...LIMITED, team: { id: 'app' } });
      for (const [id, config] of Object.entries({ ...SUB_TEAMS, ...(web === undefined ? {} : { web }) })) {
        await team.kit.files.write(teamConfigOf(id), formatConfig(config));
      }
      return team;
    }

    function liftsLogged(kit: CliHarness): number {
      return (kit.files.get(LIFTS) ?? '').split('\n').filter((line) => line !== '').length;
    }

    it("lets the lead top a child team's session up from its own team's daily budget, logged in its own lift log", async () => {
      const { kit, run } = await tree({ ...SUB_TEAMS['web'], budget: { weeklyLimitW: 1_000_000_000 } });
      const AS_WEB = { env: { TEAMRIG_TEAM: 'web' } };
      /** Web's daily budget, in % of the week, as web's own `budget` shows it. */
      const webBudget = async (): Promise<number> => {
        const lines = ok(await run(['budget'], AS_WEB));
        const pct = lines.map((each) => /^ {2}the team +\S+ +(\d+\.\d+)%/.exec(each)?.[1]).find((each) => each !== undefined);
        assert.ok(pct !== undefined, lines.join('\n'));
        return Number(pct);
      };
      const before = await webBudget();
      const out = ok(await run(crossLift('web/front', '18')));
      const week = /\((\d+\.\d+)% of the week now\)/.exec(out[0] ?? '')?.[1];
      assert.ok(week !== undefined, out.join('\n'));
      assert.deepEqual(out, [lifted('web/web-front', '18.0', week)]);
      assert.equal(liftsLogged(kit), 1);
      // The share of the week the lift said is what web's budget takes from app's lift log, both rounded to 0.1.
      const rise = (await webBudget()) - before;
      assert.ok(Math.abs(rise - Number(week)) <= 0.15, `web's budget rose ${rise.toFixed(2)}, the lift said ${week}%`);
    });

    it('lifts a session of a team two levels below', async () => {
      const { run } = await tree();
      // 10% of app's part of the account's day beside the teams under it, 3.7% as its team row shows it.
      const lines = ok(await run(['budget']));
      assert.ok(lines.some((line) => /^ {2}the team +\S+ +3\.7%/.test(line)), lines.join('\n'));
      assert.deepEqual(ok(await run(crossLift('ui/pixel', '10'))), [lifted('ui/ui-pixel', '10.0', '0.37')]);
    });

    it("refuses a top-up past what the team's other lifts leave of its daily budget", async () => {
      const { kit, run } = await tree();
      ok(await run(crossLift('alpha', '90')));
      const refused = await run(crossLift('web/front', '20'));
      assert.equal(refused.code, EXIT.refused);
      assert.match(refused.stdout.join('\n'), /other lifts in force give 90\.0% of team app's daily budget, so --part 20 would give more than all of it/);
      assert.equal(liftsLogged(kit), 1);
    });

    it('is refused to a session that is not the lead', async () => {
      const { kit, run } = await tree();
      const refused = await run(crossLift('web/front', '18', 'alpha'));
      assert.equal(refused.code, EXIT.refused);
      assert.match(refused.stdout.join('\n'), /lifts a session of a team under its own/);
      assert.equal(liftsLogged(kit), 0);
    });

    it('is refused for a team on another Claude account, a team not under the own and a session not on the team', async () => {
      const { kit, run } = await tree({ ...SUB_TEAMS['web'], budget: { account: 'work' } });
      await onAnotherLogin(kit, 'web');
      const other = await run(crossLift('web/front', '18'));
      assert.equal(other.code, EXIT.refused, other.stdout.join('\n'));
      assert.match(other.stdout.join('\n'), /team web is on another Claude account than team app/);
      const sibling = await run(crossLift('ops/run', '18'), { env: { TEAMRIG_TEAM: 'web' } });
      assert.equal(sibling.code, EXIT.refused);
      assert.match(sibling.stdout.join('\n'), /team ops is not a team under team web/);
      const unknown = await run(crossLift('ops/nobody', '18'));
      assert.equal(unknown.code, EXIT.refused);
      assert.match(unknown.stdout.join('\n'), /^REFUSED on team ops, /);
    });

    it('takes no --group', async () => {
      const { run } = await tree();
      usageError(await run([...crossLift('web/lead', '18'), '--group']), /--group lifts a sub-lead's group of team app/);
    });
  });

  it('refuses a lift the team bounds do not allow, writing nothing', async () => {
    const { kit, run } = await world();
    const refused = await run(['budget', 'lift', 'alpha', '--part', '50', '--reason', 'release', '--session', 'lead']);
    assert.equal(refused.code, EXIT.refused);
    assert.match(refused.stdout.join('\n'), /needs --stop-pct/);
    assert.equal(kit.files.get(join(TEAM_HOME, 'state', 'usage', 'lifts.jsonl')), undefined);
  });

  it('checks its flags', async () => {
    const { run } = await world();
    const as = ['--session', 'lead'];
    usageError(await run(['budget', 'lift', 'alpha', '--stop-pct', '97', '--reason', 'r', ...as]), /--part is required/);
    usageError(await run(['budget', 'lift', 'alpha', '--part', '0', '--stop-pct', '97', '--reason', 'r', ...as]), /--part "0" is not a percent above 0 and up to 100/);
    usageError(await run(['budget', 'lift', 'alpha', '--part', '50', '--stop-pct', ' ', '--reason', 'r', ...as]), /--stop-pct " " is not a percent/);
    usageError(await run(['budget', 'lift', 'alpha', '--part', '50', '--stop-pct', '97', '--reason', '  ', ...as]), /--reason needs a reason/);
    usageError(await run(['budget', 'lift', 'alpha', '--part', '50', '--stop-pct', '97', '--reason', 'r', ...as, '--until', 'soon']), /--until "soon" is not HH:MM/);
    usageError(await run(['budget', 'lift', 'alpha', '--part', '50', '--stop-pct', '97', ...as]), /--reason is required/);
    usageError(await run(['budget', 'lift', '--part', '50', '--stop-pct', '97', '--reason', 'r', ...as]), /needs <session>/);
  });
});

describe('teamrig budget cut', () => {
  const CUTS = join(TEAM_HOME, 'state', 'usage', 'cuts.jsonl');
  const CUT = ['budget', 'cut', 'alpha', '--reason', 'over on a p3'];
  const cutLine = (who: string, until: string): string =>
    `CUT ${who} to its own daily budget until ${until}: past it, it is held whatever room the team has, so it wakes for p0 work only and budget.overAction holds its new helpers back as it says; a lift in force still sets that budget, and a new lift of it ends the cut.`;
  const records = (text: string | undefined): unknown[] =>
    (text ?? '')
      .split('\n')
      .filter((line) => line !== '')
      .map((line): unknown => JSON.parse(line));

  it("cuts a session to its own daily budget for today, logged in the team's cut log", async () => {
    const { kit, run } = await world();
    assert.deepEqual(ok(await run([...CUT, '--session', 'lead'])), [cutLine('app-alpha', '00:00 UTC (the end of the budget day)')]);
    assert.deepEqual(ok(await run(['budget', 'cut', 'app/alpha', '--until', '18:00', '--reason', 'over on a p3', '--session', 'lead'])), [cutLine('app-alpha', '18:00 UTC')]);
    assert.deepEqual(records(kit.files.get(CUTS)), [
      { v: 1, session: 'alpha', endsAt: '2030-01-09T00:00:00.000Z', reason: 'over on a p3', by: 'lead', at: '2030-01-08T10:00:00.000Z' },
      { v: 1, session: 'alpha', endsAt: '2030-01-08T18:00:00.000Z', reason: 'over on a p3', by: 'lead', at: '2030-01-08T10:00:00.000Z' },
    ]);
  });

  it("reads --until on the team's clock, and refuses one that has passed, writing nothing", async () => {
    const { kit, run } = await world();
    const JERUSALEM = { timeZone: 'Asia/Jerusalem' };
    assert.deepEqual(ok(await run([...CUT, '--until', '14:00', '--session', 'lead'], JERUSALEM)), [cutLine('app-alpha', '14:00 IST')]);
    const passed = await run([...CUT, '--until', '11:00', '--session', 'lead'], JERUSALEM);
    assert.equal(passed.code, EXIT.refused);
    assert.match(passed.stdout.join('\n'), /--until 2030-01-08 11:00 IST has passed/);
    assert.equal(records(kit.files.get(CUTS)).length, 1);
  });

  it('is refused to a session that leads none, naming who cuts, writing nothing', async () => {
    const { kit, run } = await world();
    const refused = await run([...CUT, '--session', 'bravo']);
    assert.equal(refused.code, EXIT.refused);
    assert.deepEqual(refused.stdout, ["REFUSED app-alpha's budget is cut only by app-lead"]);
    assert.equal(kit.files.get(CUTS), undefined);
  });

  it('lets a sub-lead cut its members and its own session, and no session outside its group', async () => {
    const { run } = await world({ ...LIMITED, leads: { bravo: ['alpha'] } });
    assert.deepEqual(ok(await run([...CUT, '--session', 'bravo'])), [cutLine('app-alpha', '00:00 UTC (the end of the budget day)')]);
    assert.deepEqual(ok(await run(['budget', 'cut', 'bravo', '--reason', 'over on a p3', '--session', 'bravo'])), [cutLine('app-bravo', '00:00 UTC (the end of the budget day)')]);
    const outside = await run(['budget', 'cut', 'lead', '--reason', 'over on a p3', '--session', 'bravo']);
    assert.deepEqual(outside.stdout, ["REFUSED app-lead's budget is cut only by app-lead"]);
    const member = await run(['budget', 'cut', 'bravo', '--reason', 'over on a p3', '--session', 'alpha']);
    assert.deepEqual(member.stdout, ["REFUSED app-bravo's budget is cut only by app-bravo or app-lead"]);
  });

  it('checks its flags, and cuts only a session of its own team', async () => {
    const { kit, run } = await world();
    const as = ['--session', 'lead'];
    usageError(await run(['budget', 'cut', 'alpha', ...as]), /--reason is required/);
    usageError(await run(['budget', 'cut', 'alpha', '--reason', '  ', ...as]), /--reason needs a reason/);
    usageError(await run([...CUT, '--until', 'soon', ...as]), /--until "soon" is not HH:MM/);
    usageError(await run(['budget', 'cut', '--reason', 'r', ...as]), /needs <session>/);
    usageError(await run(['budget', 'cut', 'web/alpha', '--reason', 'r', ...as]), /budget cut cuts a session of team app; web\/alpha is cut by its own team's leaders/);
    assert.equal(kit.files.get(CUTS), undefined);
  });
});

describe('teamrig budget extra', () => {
  const EXTRA_LOG = join(TEAM_HOME, 'state', 'usage', 'extra-log.jsonl');
  /** The week 30% used on the status line, and $1 of extra usage worth 1M W until spent readings teach a rate. */
  const PRICED: JsonRecord = { ...TEAM, budget: { weeklyLimitW: 1_000_000_000, extraWPerUsd: 1_000_000 } };

  function logged(kit: CliHarness): unknown[] {
    return (kit.files.get(EXTRA_LOG) ?? '')
      .split('\n')
      .filter((line) => line !== '')
      .map((line): unknown => JSON.parse(line));
  }

  it("logs the lead's add and spent readings with the week's use and the W since the period's start, then names the pool", async () => {
    const { kit, run } = await world(PRICED);
    const added = ok(await run(['budget', 'extra', '--add', '10', '--session', 'lead']));
    assert.equal(added[0], 'EXTRA added $10.00 to the pool.');
    assert.match(added[1] ?? '', /^Week: 30\.0% used .* Extra usage: \$10\.00 of \$10\.00 left, about 10\.00M W at 1\.00M W per dollar \(budget\.extraWPerUsd\)\.$/);
    assert.equal(added.length, 2);
    const spent = ok(await run(['budget', 'extra', '--spent', '2', '--session', 'lead']));
    assert.equal(spent[0], 'EXTRA $2.00 spent from it so far.');
    assert.match(spent[1] ?? '', / Extra usage: \$8\.00 of \$10\.00 left, about 8\.00M W at 1\.00M W per dollar \(budget\.extraWPerUsd\)\.$/);
    const entry = { at: '2030-01-08T10:00:00.000Z', weekPct: 30, start: '2030-01-07T01:00:00.000Z', end: '2030-01-14T01:00:00.000Z', w: 26_000_000 };
    assert.deepEqual(logged(kit), [
      { v: 1, ...entry, kind: 'add', usd: 10 },
      { v: 1, ...entry, kind: 'spent', usd: 2 },
    ]);
  });

  it('takes an add and a spent reading at once, and with no flag shows the pool, or that there is none', async () => {
    const { run } = await world();
    const none = ok(await run(['budget', 'extra']));
    assert.match(none[0] ?? '', /^Week: 30\.0% used .* Resets Mon 01-14 01:00 UTC\.$/);
    assert.equal(none[1], 'Extra usage: none in the pool (the lead adds the dollars put in it: teamrig budget extra --add <usd>).');
    assert.equal(ok(await run(['budget', 'extra', '--add', '5', '--spent', '1', '--session', 'lead']))[0], 'EXTRA added $5.00 to the pool; $1.00 spent from it so far.');
    const shown = ok(await run(['budget', 'extra']));
    assert.equal(shown.length, 1);
    assert.match(shown[0] ?? '', / Extra usage: \$4\.00 of \$5\.00 left, in dollars only until two spent readings past 100% /);
  });

  it('is the lead only, writing nothing for anyone else', async () => {
    const { kit, run } = await world();
    const refused = await run(['budget', 'extra', '--add', '10', '--session', 'bravo']);
    assert.equal(refused.code, EXIT.refused);
    assert.deepEqual(refused.stdout, ['REFUSED only the lead (app-lead) enters the extra-usage pool']);
    assert.equal(kit.files.get(EXTRA_LOG), undefined);
  });

  it('checks its flags', async () => {
    const { run } = await world();
    const as = ['--session', 'lead'];
    usageError(await run(['budget', 'extra', '--add', '0', ...as]), /--add "0" is not a dollar amount above 0/);
    usageError(await run(['budget', 'extra', '--add', 'ten', ...as]), /--add "ten" is not a dollar amount above 0/);
    usageError(await run(['budget', 'extra', '--spent', ' ', ...as]), /--spent " " is not a dollar amount of 0 or more/);
    usageError(await run(['budget', 'extra', 'alpha']), /unexpected "alpha"/);
  });
});

describe("teamrig budget in a child team on its parent's account", () => {
  const HOUR = MS_PER_DAY / 24;
  const ORG_USAGE = join(teamHomeOf('org'), 'state', 'usage');
  const APP_USAGE = join(TEAM_HOME, 'state', 'usage');

  /**
   * The harness's team `app` under `org` (whose config adds `org`), its budget block `app`'s, and org's meter log
   * with 2 readings at 20M W per percent, logged for `team` (`app` unless named; null logs them untagged, as before
   * T1669).
   */
  async function childWorld(org: JsonRecord = {}, app: JsonRecord = {}, team: string | null = 'app'): Promise<World> {
    const child = await world({ ...LIMITED, team: { id: 'app', parent: 'org' }, budget: { weeklyLimitW: 1_000_000_000, ...app } }, false);
    const { kit, run } = child;
    await kit.files.write(teamConfigOf('org'), formatConfig({ configVersion: 1, team: { id: 'org' }, sessions: ['lead'], roles: { lead: 'lead' }, ...org }));
    const now = kit.clock.now();
    const period = { start: now - MS_PER_DAY, end: now + 6 * MS_PER_DAY, forecastPct: undefined, ...(team === null ? {} : { team }) };
    const log = new MeterLog(kit.files, join(ORG_USAGE, 'meter-log.jsonl'));
    await log.append({ ...period, at: now - 2 * HOUR, usedPct: 5, w: 100_000_000 }, now);
    await log.append({ ...period, at: now - HOUR, usedPct: 15, w: 300_000_000 }, now);
    ok(await run(['statusline'], { stdin: status(APP) }));
    return child;
  }

  /**
   * The status line passing 31% a minute after the account's period, kept in `usage`, read 30% in a week whose start
   * was seen (Monday 2030-01-07 01:00 UTC), with app's alpha and org's lead stored as having metered 40M and 70M W on
   * that day, so both teams' stores reach its start; the lines `teamrig budget` then logs at 31% in the meter log
   * there, as team and W.
   */
  async function crossOnePercent({ kit, run }: World, usage: string): Promise<ReadonlyArray<readonly [string | undefined, number]>> {
    for (const [folder, id, w] of [[APP_USAGE, 'alpha', 40_000_000], [ORG_USAGE, 'lead', 70_000_000]] as const) {
      const store = new UsageStore(kit.files, folder);
      const byDay = { '2030-01-07': { w, calls: 1, patterns: emptyPatterns() } };
      assert.ok(await store.save(id, { ...EMPTY_USAGE, byDay }, (await store.load(id)).rev), `${id}'s use saved`);
    }
    const period = { start: Date.parse('2030-01-07T01:00:00Z'), end: RESET, kind: 'week', lastPct: 30, lastAt: kit.clock.now() } as const;
    await kit.files.write(join(usage, 'period.json'), formatPeriod(period));
    kit.clock.advance(60_000);
    ok(await run(['statusline'], { stdin: status(APP, 31) }));
    ok(await run(['budget']));
    const readings = await new MeterLog(kit.files, join(usage, 'meter-log.jsonl')).read(kit.clock.now());
    return readings.filter((reading) => reading.usedPct === 31).map((reading) => [reading.team, reading.w] as const);
  }

  it("reads and writes the week's files of the highest team above it on the account, learning its W per percent from its own lines there", async () => {
    const { kit, run } = await childWorld();
    assert.match(ok(await run(['budget'])).at(-1) ?? '', /1% of the week is about 20\.00M W, learned from 2 meter readings/);
    assert.notEqual(kit.files.get(join(ORG_USAGE, 'period.json')), undefined);
    assert.equal(kit.files.get(join(APP_USAGE, 'period.json')), undefined);
    ok(await run(['budget', 'extra', '--add', '10', '--session', 'lead']));
    assert.match(kit.files.get(join(ORG_USAGE, 'extra-log.jsonl')) ?? '', /"kind":"add"/);
    assert.equal(kit.files.get(join(APP_USAGE, 'extra-log.jsonl')), undefined);
  });

  it("keeps its own when it names an account other than its parent's", async () => {
    const { kit, run } = await childWorld({ budget: { account: 'work' } }, { account: 'home' });
    assert.equal(ok(await run(['budget'])).at(-1), W_EXPLAINED);
    assert.notEqual(kit.files.get(join(APP_USAGE, 'period.json')), undefined);
    assert.equal(kit.files.get(join(ORG_USAGE, 'period.json')), undefined);
  });

  it("is on its parent's account when it names none, though the parent names one", async () => {
    const { kit, run } = await childWorld({ budget: { account: 'work' } });
    assert.match(ok(await run(['budget'])).at(-1) ?? '', /learned from 2 meter readings/);
    assert.equal(kit.files.get(join(APP_USAGE, 'period.json')), undefined);
  });

  it("learns nothing from the lines its parent's stores metered, nor from untagged ones, which were on its parent's scale (T1669)", async () => {
    for (const team of ['org', null]) {
      const { run } = await childWorld({}, {}, team);
      assert.equal(ok(await run(['budget'])).at(-1), W_EXPLAINED, `lines of ${team ?? 'no team'}`);
    }
  });

  it("logs a percent the status line passed once for itself and once for its parent, each with its own stores' W (T1669)", async () => {
    const child = await childWorld();
    assert.deepEqual(await crossOnePercent(child, ORG_USAGE), [
      ['app', 66_000_000],
      ['org', 70_000_000],
    ]);
  });

  it('logs it for itself alone in its own files when its parent is on another account', async () => {
    const child = await childWorld({ budget: { account: 'work' } }, { account: 'home' });
    assert.deepEqual(await crossOnePercent(child, APP_USAGE), [['app', 66_000_000]]);
  });
});

describe('the budget of a team without a budget block under teams with one', () => {
  /** The harness's team `app`, the root of SUB_TEAMS, with the budget on and its weekly limit set, and a status line reading saved. */
  async function rootWorld(): Promise<World> {
    const team = await world({ ...TEAM, team: { id: 'app' }, budget: { enabled: true, weeklyLimitW: 1_000_000_000 } });
    for (const [id, config] of Object.entries(SUB_TEAMS)) {
      await team.kit.files.write(teamConfigOf(id), formatConfig(config));
    }
    return team;
  }
  const AS_UI = { env: { TEAMRIG_TEAM: 'ui' } };

  it("is on and reads the week by the root's weekly limit, two levels down", async () => {
    const { run } = await rootWorld();
    assert.match(ok(await run(['rules'], AS_UI)).join('\n'), /Pace the week to 99\.5% of the limit/);
    assert.equal(ok(await run(['budget'], AS_UI)).at(-1), W_EXPLAINED, 'the configured weekly limit, not an estimate from the status line');
  });

  it('stops at the first team met again when the parent links go round in a loop, off the root', async () => {
    const { kit, run } = await rootWorld();
    await kit.files.write(teamConfigOf('web'), formatConfig({ ...SUB_TEAMS['web'], team: { id: 'web', parent: 'ui' } }));
    assert.doesNotMatch(ok(await run(['rules'], AS_UI)).join('\n'), /Pace the week to/);
    ok(await run(['budget'], AS_UI));
  });
});

describe('teamrig statusline', () => {
  const SNAPSHOT = `${ALPHA_TAB}.json`;
  /** The status `status(APP)` prints by default: on the harness's branch `dev`. */
  const SHOWN = `Opus 5.5, ${basename(APP)} on dev, week 30%, 5h 6%, claude --resume ${ALPHA_TAB}`;

  /** A repository whose branch and HEAD answers are counted. */
  function countedRepo(branch: string | undefined, head: string | undefined) {
    return {
      branch: mock.fn((_dir: string): string | undefined => branch),
      head: mock.fn((_dir: string): string | undefined => head),
      pushTarget: (): string | undefined => undefined,
      config: () => ({ kind: 'unset' }),
    } satisfies RepoState;
  }

  it("saves the status input's reading to the kit's live folder and prints a short status", async () => {
    const kit = new CliHarness(LIMITED);
    const result = await kit.run(['statusline'], { stdin: status(APP) });
    assert.deepEqual([result.code, result.stdout, result.stderr], [EXIT.ok, [SHOWN], []]);
    assert.match(kit.files.get(join(LIVE, SNAPSHOT)) ?? '', /"seven_day":\{"used_percentage":30,"resets_at":1894582800\}/);
    assert.match(kit.files.get(join(LIVE, WEEK_SUMMARY_FILE)) ?? '', /^\{"v":1,"reading":\{"used_percentage":30,"resets_at":1894582800,"at":"2030-01-08T10:00:00\.000Z"\},/);
  });

  it("dates each reading by the session's previous snapshot, so a reading after a mid-week reset outranks older higher ones", async () => {
    const { kit, run } = await world(LIMITED, false);
    const input = (session: string, weekPct: number, fiveHourPct: number): string =>
      JSON.stringify({
        session_id: session,
        cwd: APP,
        rate_limits: { five_hour: { used_percentage: fiveHourPct, resets_at: RESET / 1000 - 86_400 }, seven_day: { used_percentage: weekPct, resets_at: RESET / 1000 } },
      });
    const dates = (session: string): readonly (string | null | undefined)[] => {
      const saved = parseSnapshot(kit.files.get(join(LIVE, `${session}.json`)) ?? '');
      return [saved?.rateLimitsSince, saved?.rateLimitsAfter];
    };
    ok(await run(['statusline'], { stdin: input(BRAVO_TAB, 98, 40) }));
    ok(await run(['statusline'], { stdin: input(ALPHA_TAB, 98, 40) }));
    kit.clock.advance(60_000);
    ok(await run(['statusline'], { stdin: input(ALPHA_TAB, 98, 40) }));
    assert.deepEqual(dates(ALPHA_TAB), ['2030-01-08T10:00:00.000Z', null]);
    kit.clock.advance(60_000);
    ok(await run(['statusline'], { stdin: input(BRAVO_TAB, 98, 40) }));
    ok(await run(['statusline'], { stdin: input(ALPHA_TAB, 0.5, 1) }));
    assert.deepEqual(dates(ALPHA_TAB), ['2030-01-08T10:02:00.000Z', '2030-01-08T10:01:00.000Z']);
    assert.deepEqual(dates(BRAVO_TAB), ['2030-01-08T10:00:00.000Z', null]);
    assert.match(ok(await run(['budget']))[0] ?? '', /^Week: 0\.50% used at 10:02 UTC/);
  });

  it('counts a new budget from the reading before the use fell inside the week, once a reader saw both', async () => {
    // The week read 30% at 10:00; at 11:00 it reads 0.5% with the same reset: the use was reset inside the week.
    const { kit, run } = await world();
    assert.match(ok(await run(['budget']))[0] ?? '', /^Week: 30\.0% used at 10:00 UTC/);
    kit.clock.advance(3_600_000);
    const fallen = JSON.stringify({ session_id: ALPHA_TAB, cwd: APP, rate_limits: { seven_day: { used_percentage: 0.5, resets_at: RESET / 1000 } } });
    ok(await run(['statusline'], { stdin: fallen }));
    const lines = ok(await run(['budget']));
    // The pace line runs from 10:00 to an hour before the reset, 134 hours: 1 of them is 0.74%.
    assert.match(lines[0] ?? '', /^Week: 0\.50% used at 11:00 UTC \(status line\); the pace line is at 0\.74%/);
    assert.match(lines[0] ?? '', / Counted from \w{3} 01-08 10:00 UTC, after a reset inside the week\.$/);
    // Today's use counts from 10:00 too: the team's 09:00 calls were the last budget's.
    assert.match(lines[3] ?? '', /^ {2}the team +0[.0]*% /);
    const period = parsePeriod(kit.files.get(join(TEAM_HOME, 'state', 'usage', 'period.json')) ?? '');
    assert.deepEqual([period?.kind, period?.start], ['reset', Date.parse('2030-01-08T10:00:00Z')]);
  });

  it("saves to the team's budget.statusSnapshotDir, relative to the team's folder or absolute, and budget reads it there", async () => {
    const relative = await world({ ...LIMITED, budget: { weeklyLimitW: 1_000_000_000, statusSnapshotDir: 'live' } });
    assert.notEqual(relative.kit.files.get(join(TEAM_HOME, 'live', SNAPSHOT)), undefined);
    assert.equal(relative.kit.files.get(join(LIVE, SNAPSHOT)), undefined);
    assert.match(ok(await relative.run(['budget']))[0] ?? '', /^Week: 30\.0% used at 10:00 UTC/);
    const elsewhere = join('/', 'snap');
    const absolute = await world({ ...LIMITED, budget: { weeklyLimitW: 1_000_000_000, statusSnapshotDir: elsewhere } });
    assert.notEqual(absolute.kit.files.get(join(elsewhere, SNAPSHOT)), undefined);
  });

  it("saves to the kit's live folder outside any team or when the team's config is unreadable", async () => {
    const kit = new CliHarness({ ...LIMITED, budget: { statusSnapshotDir: 'live' } }, null);
    const outside = join('/', 'elsewhere');
    ok(await kit.run(['statusline'], { stdin: status(outside), cwd: outside }));
    assert.notEqual(kit.files.get(join(LIVE, SNAPSHOT)), undefined);
    const broken = new CliHarness('{ not json');
    ok(await broken.run(['statusline'], { stdin: status(APP) }));
    assert.notEqual(broken.files.get(join(LIVE, SNAPSHOT)), undefined);
  });

  it("shows a detached HEAD by its commit, asking git for the branch in the session's folder", async () => {
    const repo = countedRepo(undefined, '1a2b3c4');
    const kit = new CliHarness(LIMITED);
    assert.deepEqual(ok(await kit.run(['statusline'], { stdin: status(APP), git: repo })), [
      `Opus 5.5, ${basename(APP)} at 1a2b3c4, week 30%, 5h 6%, claude --resume ${ALPHA_TAB}`,
    ]);
    assert.deepEqual(repo.branch.mock.calls.map((call) => call.arguments), [[APP]]);
    assert.deepEqual(repo.head.mock.calls.map((call) => call.arguments), [[APP]]);
  });

  it("shows only what the team's statusLine config leaves on, and asks git nothing when the branch is off", async () => {
    const repo = countedRepo('main', '1a2b3c4');
    const bare = new CliHarness({ ...LIMITED, statusLine: { folder: false, branch: false, resume: false } });
    assert.deepEqual(ok(await bare.run(['statusline'], { stdin: status(APP), git: repo })), ['Opus 5.5, week 30%, 5h 6%']);
    assert.equal(repo.branch.mock.callCount() + repo.head.mock.callCount(), 0);
    const branchOnly = new CliHarness({ ...LIMITED, statusLine: { folder: false, resume: false } });
    assert.deepEqual(ok(await branchOnly.run(['statusline'], { stdin: status(APP), git: repo })), ['Opus 5.5, on main, week 30%, 5h 6%']);
    assert.equal(repo.head.mock.callCount(), 0);
  });

  it("shows the default display outside any team, in the folder the status line runs in when the input names none", async () => {
    const kit = new CliHarness(LIMITED, null);
    const outside = join('/', 'elsewhere');
    const input = JSON.stringify({ ...JSON.parse(status(outside)), cwd: '', workspace: {} });
    assert.deepEqual(ok(await kit.run(['statusline'], { stdin: input, cwd: outside })), [
      `Opus 5.5, elsewhere on dev, week 30%, 5h 6%, claude --resume ${ALPHA_TAB}`,
    ]);
  });

  it('with --pass prints the status input again for the status line after it, and still saves the reading', async () => {
    const kit = new CliHarness(LIMITED);
    const input = status(APP);
    const result = await kit.run(['statusline', '--pass'], { stdin: `${input}\n` });
    assert.deepEqual([result.code, result.stdout, result.stderr], [EXIT.ok, [input], []]);
    assert.notEqual(kit.files.get(join(LIVE, SNAPSHOT)), undefined);
    const bad = await kit.run(['statusline', '--pass'], { stdin: 'not json' });
    assert.deepEqual([bad.code, bad.stdout], [EXIT.ok, ['not json']]);
  });

  it('never fails the status bar: a bad input or a failed write is told on stderr', async () => {
    const kit = new CliHarness(LIMITED);
    assert.deepEqual(await kit.run(['statusline'], { stdin: 'not json' }), {
      code: EXIT.ok,
      stdout: ['Claude'],
      stderr: ['teamrig statusline: the status input is not Claude Code status JSON with a session id; nothing saved'],
    });
    const files = new FaultyFiles(kit.files).fail('write', join(LIVE, SNAPSHOT), systemError('EACCES'));
    assert.deepEqual(await kit.run(['statusline'], { stdin: status(APP), files }), {
      code: EXIT.ok,
      stdout: [SHOWN],
      stderr: ['teamrig statusline: the snapshot was not saved: EACCES: simulated'],
    });
    usageError(await kit.run(['statusline', 'extra']), /unexpected "extra"/);
  });

  it("removes the folder's snapshots written more than 8 days ago, sweeping at most once an hour", async () => {
    const kit = new CliHarness(LIMITED);
    const writtenAgo = (session: string, ms: number): string => JSON.stringify({ ts: new Date(kit.clock.now() - ms).toISOString(), session_id: session });
    const old = join(LIVE, `${BRAVO_TAB}.json`);
    await kit.files.write(old, writtenAgo(BRAVO_TAB, 9 * MS_PER_DAY));
    ok(await kit.run(['statusline'], { stdin: status(APP) }));
    assert.equal(kit.files.get(old), undefined);
    assert.notEqual(kit.files.get(join(LIVE, SNAPSHOT)), undefined);
    await kit.files.write(old, writtenAgo(BRAVO_TAB, 9 * MS_PER_DAY));
    ok(await kit.run(['statusline'], { stdin: status(APP) }));
    assert.notEqual(kit.files.get(old), undefined);
  });

  it('tells a failed prune on stderr and still shows the status, with the snapshot saved', async () => {
    const kit = new CliHarness(LIMITED);
    const files = new FaultyFiles(kit.files).fail('write', join(LIVE, SNAPSHOT_PRUNED_FILE), systemError('EACCES'));
    assert.deepEqual(await kit.run(['statusline'], { stdin: status(APP), files }), {
      code: EXIT.ok,
      stdout: [SHOWN],
      stderr: ['teamrig statusline: old snapshots were not pruned: EACCES: simulated'],
    });
    assert.notEqual(kit.files.get(join(LIVE, SNAPSHOT)), undefined);
  });

  it('tells a failed week summary write on stderr and still shows the status, saves the snapshot and prunes', async () => {
    const kit = new CliHarness(LIMITED);
    const files = new FaultyFiles(kit.files).fail('write', join(LIVE, WEEK_SUMMARY_FILE), systemError('EACCES'));
    assert.deepEqual(await kit.run(['statusline'], { stdin: status(APP), files }), {
      code: EXIT.ok,
      stdout: [SHOWN],
      stderr: ['teamrig statusline: the week summary was not updated: EACCES: simulated'],
    });
    assert.notEqual(kit.files.get(join(LIVE, SNAPSHOT)), undefined);
    assert.notEqual(kit.files.get(join(LIVE, SNAPSHOT_PRUNED_FILE)), undefined);
  });
});
