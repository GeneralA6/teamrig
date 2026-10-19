import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { parsePeriod } from '../budget/period.ts';
import { W_EXPLAINED } from '../budget/report.ts';
import { parseSnapshot, SNAPSHOT_PRUNED_FILE } from '../budget/snapshot.ts';
import type { JsonRecord } from '../core/guards.ts';
import { MS_PER_DAY } from '../core/time.ts';
import { APP, CliHarness, KIT, TEAM, TEAM_HOME, USER_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { replyLine, transcript } from '../testing/transcript-lines.ts';
import type { RepoState } from '../push-guard/push.ts';
import { defaultSnapshotDir, snapshotDirOf } from './commands/budget.ts';
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

/** Claude Code's status input for a session in `cwd`: the week 30% used. */
function status(cwd: string): string {
  return JSON.stringify({
    session_id: ALPHA_TAB,
    cwd,
    workspace: { current_dir: cwd },
    model: { display_name: 'Opus 5.5' },
    rate_limits: { five_hour: { used_percentage: 6, resets_at: RESET / 1000 - 86_400 }, seven_day: { used_percentage: 30, resets_at: RESET / 1000 } },
  });
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
      'The team used 2.5% of the week today; its daily budget is 12.4%. 25.00M W in 3 calls.',
      'app-alpha used 2.0% of the week today; its daily budget is 4.1%. 20.00M W in 2 calls.',
      'app-bravo used 0.50% of the week today; its daily budget is 4.1%. 5.00M W in 1 call.',
      OUTSIDE_LINE,
      W_EXPLAINED,
    ]);
    assert.deepEqual(ok(await run(['budget', '--all'])).slice(4, 5), ['No use today: app-lead.']);
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
    assert.ok(ok(await run(['budget'])).includes('app-bravo used 0.80% of the week today; its daily budget is 4.1%. 8.00M W in 2 calls.'));
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
    assert.equal(lines[1], 'The team used 25.00M W in 3 calls today.');
  });
});

describe('teamrig budget lift', () => {
  const LIFT = ['budget', 'lift', 'alpha', '--part', '50', '--stop-pct', '97', '--reason', 'release'];

  it("lifts a session to a part of the team's daily budget for today, logged and shown by budget", async () => {
    const { kit, run } = await world();
    assert.deepEqual(ok(await run([...LIFT, '--session', 'lead'])), [
      "LIFTED app-alpha to 50.0% of the team's daily budget today until 00:00 UTC (the end of the budget day) or 97.0% of the week, whichever comes first; quiet hours do not apply to it.",
    ]);
    assert.equal((kit.files.get(join(TEAM_HOME, 'state', 'usage', 'lifts.jsonl')) ?? '').split('\n').filter((line) => line !== '').length, 1);
    const lines = ok(await run(['budget']));
    // Half the team's 12.4% to alpha; the other half split between lead and bravo.
    assert.equal(lines[2], 'app-alpha used 2.0% of the week today; its daily budget is 6.2% (lifted). 20.00M W in 2 calls.');
    assert.equal(lines[3], 'app-bravo used 0.50% of the week today; its daily budget is 3.1%. 5.00M W in 1 call.');
    assert.equal(
      lines[4],
      "Budget: the lead lifted app-alpha to 50.0% of the team's daily budget today until 00:00 UTC (the end of the budget day) or 97.0% of the week, whichever comes first; quiet hours do not apply to it.",
    );
    assert.deepEqual(ok(await run([...LIFT, '--until', '18:00', '--session', 'lead'])), [
      "LIFTED app-alpha to 50.0% of the team's daily budget today until 18:00 UTC or 97.0% of the week, whichever comes first; quiet hours do not apply to it.",
    ]);
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
    assert.equal(lines[2], 'app-alpha used 2.0% of the week today; its daily budget is 8.9%. 20.00M W in 2 calls.');
    assert.equal(lines[3], 'app-bravo used 0.50% of the week today; its daily budget is 1.8%. 5.00M W in 1 call.');
  });

  it("reads --until on the team's clock, and prints the lift's end and the week on it", async () => {
    const { run } = await world();
    const JERUSALEM = { timeZone: 'Asia/Jerusalem' };
    assert.deepEqual(ok(await run([...LIFT, '--until', '14:00', '--session', 'lead'], JERUSALEM)), [
      "LIFTED app-alpha to 50.0% of the team's daily budget today until 14:00 IST or 97.0% of the week, whichever comes first; quiet hours do not apply to it.",
    ]);
    const lines = ok(await run(['budget'], JERUSALEM));
    assert.match(lines[0] ?? '', / Resets \w{3} \d{2}-\d{2} \d{2}:\d{2} IST\.$/);
    assert.match(lines[4] ?? '', /lifted app-alpha to 50\.0% of the team's daily budget today until 14:00 IST or /);
    const passed = await run([...LIFT, '--until', '11:00', '--session', 'lead'], JERUSALEM);
    assert.equal(passed.code, EXIT.refused);
    assert.match(passed.stdout.join('\n'), /--until 2030-01-08 11:00 IST has passed/);
  });

  it('is the lead only', async () => {
    const { run } = await world();
    const refused = await run([...LIFT, '--session', 'bravo']);
    assert.equal(refused.code, EXIT.refused);
    assert.deepEqual(refused.stdout, ["REFUSED only the lead (app-lead) lifts a session's budget"]);
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
    assert.match(lines[1] ?? '', /^The team used 0[.0]*% of the week today/);
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
});

describe('snapshotDirOf', () => {
  it("is the team's setting, relative to its folder, else the kit's live folder", () => {
    const paths = { home: TEAM_HOME, kitHome: KIT };
    assert.equal(snapshotDirOf({}, paths), defaultSnapshotDir(KIT));
    assert.equal(snapshotDirOf({ statusSnapshotDir: 'live' }, paths), join(TEAM_HOME, 'live'));
    assert.equal(snapshotDirOf({ statusSnapshotDir: join('/', 'snap') }, paths), join('/', 'snap'));
  });
});
