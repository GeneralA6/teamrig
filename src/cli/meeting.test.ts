import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MeterLog } from '../budget/calibration.ts';
import { SPOTLIGHT_VARS } from '../meeting/spotlight.ts';
import { MEETING_LAPSE_MS } from '../meeting/state.ts';
import { MergeLog, type SelfMerge } from '../merge/merge-log.ts';
import { TEST_CARD, TEST_GATE, TEST_OWNER_CARD_FLAGS } from '../testing/card.ts';
import { APP, CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { FakeProcesses } from '../testing/fake-processes.ts';
import { SUB_TEAMS, teamConfigOf, teamHomeOf, treeHarness } from '../testing/team-tree.ts';
import { formatConfig } from '../config/load.ts';
import { EXIT } from './runtime.ts';

const MINUTE = 60_000;

/**
 * T1 owned by alpha waits on the owner's decision (which posts the lead a line), T2 owned by bravo is late, and alpha
 * left the lead an inbox line.
 */
async function teamBeforeTheMeeting(config = TEAM): Promise<CliHarness> {
  const kit = new CliHarness(config);
  const added = await kit.run(['add', '--title', 'Pick the pricing tier', '--description', 'which tier ships first', '--priority', 'p1', '--session', 'alpha']);
  assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
  await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'two options', ...TEST_OWNER_CARD_FLAGS, '--session', 'alpha']);
  await kit.run(['add', '--title', 'Ship the docs', '--description', 'what and why', '--priority', 'p2', '--owner', 'bravo', '--due', '2030-01-07', '--session', 'lead']);
  await kit.run(['inbox', 'add', '--to', 'lead', '--text', 'the build is green', '--session', 'alpha']);
  return kit;
}

async function inboxOf(kit: CliHarness, session: string): Promise<readonly string[]> {
  return (await kit.run(['inbox', 'read', '--session', session])).stdout;
}

describe('runCli: the daily meeting', () => {
  it('starts: posts no line and prints the whole agenda in one call', async () => {
    const kit = await teamBeforeTheMeeting();
    const started = await kit.run(['meeting', 'start', '--session', 'lead']);
    assert.equal(started.code, EXIT.ok, started.stderr.join('\n'));
    const { stdout } = started;
    assert.equal(stdout[0], 'MEETING started Tue 01-08 10:00 UTC: messages to app-lead are held but CRITICAL ones (the hook tells each sender)');
    assert.equal(stdout[1], 'GOALS none ranked: teamrig goal rank <tag> <n> --session lead');
    assert.equal(stdout[2], 'DECISIONS 1 waiting on owner (decision or approval)');
    assert.match(stdout[3] ?? '', /^ {2}T1 waiting, Improvements, score 3\.33, p1, owner alpha \| Pick the pricing tier/);
    assert.equal(stdout[4], '    what and why: which tier ships first');
    assert.equal(stdout[5], `    decide: ${TEST_CARD.question}`);
    assert.equal(stdout[6], `    gate: ${TEST_GATE}`);
    assert.ok(stdout.includes('    waiting since 01-08 10:00 UTC: two options'), stdout.join('\n'));
    const late = stdout.indexOf('LATE 1 past their due date');
    assert.match(stdout[late + 1] ?? '', /^ {2}T2 open, Improvements, score 30, p2, owner bravo, due 01-07 \| Ship the docs/);
    const done = stdout.indexOf('DONE 0 done, 0 dropped since Mon 01-07 10:00 UTC');
    assert.ok(done > late, stdout.join('\n'));
    assert.deepEqual(stdout.slice(done + 1, done + 4), [
      'STATS app, 7 d: 01-02 to 01-08',
      'HEALTH close/open 0.00 [bad] · backlog +2, 2 active [bad] · overdue 1, p1 0 [warn] · owner decisions 1, oldest 0.0 d [good] · backlog clears never, at this rate [bad]',
      'FLOW opened 2, closed 0 (0 dropped), net +2; last 28 d net +2',
    ]);
    assert.equal(stdout[done + 4], '  each other section: teamrig stats --tree --session lead (new work, speed, delays, waits, bugs, people, goals, areas)');
    assert.ok(stdout.some((line) => line.endsWith('alpha: the build is green')), stdout.join('\n'));
    assert.ok(stdout.some((line) => line.endsWith(`alpha: T1 waits on the owner's decision: ${TEST_CARD.question} | asked in the next batch at the daily meeting`)), stdout.join('\n'));
    assert.ok(stdout.some((line) => line.startsWith('READ lead: 2 new lines')), stdout.join('\n'));
    assert.ok(stdout.some((line) => line.startsWith('Week: ')), stdout.join('\n'));
    assert.equal(stdout.at(-1), 'END teamrig meeting end --session lead: tells each session the decisions recorded on its tasks');

    for (const session of ['alpha', 'bravo']) {
      const lines = await inboxOf(kit, session);
      assert.ok(!lines.some((line) => line.includes('daily meeting')), lines.join('\n'));
    }
    assert.match((await inboxOf(kit, 'lead'))[0] ?? '', /^READ lead: nothing new/);
  });

  // T1278, T2256: the lead asks the cards only in plain text.
  it('tells the lead to ask in plain text', async () => {
    const { stdout } = await (await teamBeforeTheMeeting(TEAM)).run(['meeting', 'start', '--session', 'lead']);
    assert.deepEqual(
      stdout.filter((line) => line.startsWith('  Ask ')),
      ["  Ask in plain text, never with the question picker: each card's options numbered, your recommendation first; owner answers in their own words."],
    );
  });

  it("prints the meeting's times on the team's clock, in its lines and its notices", async () => {
    const kit = await teamBeforeTheMeeting();
    const { stdout } = await kit.run(['meeting', 'start', '--session', 'lead'], { timeZone: 'Asia/Jerusalem' });
    assert.equal(stdout[0], 'MEETING started Tue 01-08 12:00 IST: messages to app-lead are held but CRITICAL ones (the hook tells each sender)');
    assert.ok(stdout.includes('DONE 0 done, 0 dropped since Mon 01-07 12:00 IST'), stdout.join('\n'));
    await kit.run(['update', 'T1', '--note', 'owner decided: go', '--session', 'lead']);
    const ended = await kit.run(['meeting', 'end', '--session', 'lead'], { timeZone: 'Asia/Jerusalem' });
    assert.match(ended.stdout[0] ?? '', /^MEETING ended Tue 01-08 12:00 IST after /);
    const lines = await inboxOf(kit, 'alpha');
    assert.ok(lines.some((line) => line.includes('ended Tue 01-08 12:00 IST. Decided on your tasks: T1: owner decided: go')), lines.join('\n'));
  });

  it('refuses every session but the lead', async () => {
    const kit = await teamBeforeTheMeeting();
    for (const command of ['start', 'agenda', 'end']) {
      const refused = await kit.run(['meeting', command, '--session', 'alpha']);
      assert.deepEqual([refused.code, refused.stdout], [EXIT.refused, ["REFUSED only the lead (app-lead) runs the owner's daily meeting"]]);
    }
    const noLead = new CliHarness({ sessions: ['alpha', 'bravo'] }); // a config missing its lead still reads
    assert.deepEqual((await noLead.run(['meeting', 'agenda', '--session', 'alpha'])).stdout, ["REFUSED only the lead runs the owner's daily meeting"]);
  });

  it('leaves a meeting already open as it is, and prints its agenda', async () => {
    const kit = await teamBeforeTheMeeting();
    await kit.run(['meeting', 'start', '--session', 'lead']);
    await inboxOf(kit, 'alpha');
    kit.clock.advance(10 * MINUTE);
    const again = await kit.run(['meeting', 'start', '--session', 'lead']);
    assert.equal(again.code, EXIT.ok);
    assert.equal(again.stdout[0], 'MEETING already open since Tue 01-08 10:00 UTC: messages to app-lead are held but CRITICAL ones');
    assert.equal(again.stdout[2], 'DECISIONS 1 waiting on owner (decision or approval)');
    assert.match((await inboxOf(kit, 'alpha'))[0] ?? '', /^READ alpha: nothing new/);
  });

  // T2517: the spotlight dims every screen but the lead's window while the meeting is open.
  const SPOTLIT_TEAM = { ...TEAM, meeting: { spotlight: { enabled: true, dim: 0.5, breakthroughSeconds: 45 } } };

  it('starts the spotlight on Windows when the team turns it on, once, and says so under the start line', async () => {
    const kit = await teamBeforeTheMeeting(SPOTLIT_TEAM);
    const processes = new FakeProcesses();
    const started = await kit.run(['meeting', 'start', '--session', 'lead'], { platform: 'win32', processes });
    assert.equal(started.code, EXIT.ok, started.stderr.join('\n'));
    assert.match(started.stdout[1] ?? '', /^SPOTLIGHT every screen dimmed \(0\.5\) but the window of \[app\] lead, until the meeting ends; its errors go to .*meeting-spotlight\.log$/);
    assert.equal(started.stdout[2], 'GOALS none ranked: teamrig goal rank <tag> <n> --session lead');
    assert.equal(processes.hidden.length, 1);
    const env = processes.hidden[0]?.env ?? {};
    // The lead's tab title, which the script looks the window up by.
    assert.equal(env[SPOTLIGHT_VARS.title], '[app] lead');
    assert.equal(env[SPOTLIGHT_VARS.startedAt], '2030-01-08T10:00:00.000Z');
    assert.equal(env[SPOTLIGHT_VARS.dim], '0.5');
    // The file the cold-send hook records a break-through in, and how long one lifts the dimming (T2524).
    assert.match(env[SPOTLIGHT_VARS.breakthrough] ?? '', /meeting-breakthrough\.json$/);
    assert.equal(env[SPOTLIGHT_VARS.liftMs], '45000');

    kit.clock.advance(10 * MINUTE);
    const again = await kit.run(['meeting', 'start', '--session', 'lead'], { platform: 'win32', processes });
    assert.ok(!again.stdout.some((line) => line.startsWith('SPOTLIGHT')), again.stdout.join('\n'));
    assert.equal(processes.hidden.length, 1);
  });

  it('starts the spotlight for a team that never set meeting.spotlight, as it is on by default (T2523)', async () => {
    const processes = new FakeProcesses();
    const started = await (await teamBeforeTheMeeting()).run(['meeting', 'start', '--session', 'lead'], { platform: 'win32', processes });
    assert.match(started.stdout[1] ?? '', /^SPOTLIGHT every screen dimmed \(0\.6\) but the window of \[app\] lead/);
    assert.equal(processes.hidden.length, 1);
  });

  it('starts no spotlight while the team turns it off, and says nothing off Windows, where it cannot run', async () => {
    const off = new FakeProcesses();
    const quiet = await (await teamBeforeTheMeeting({ ...TEAM, meeting: { spotlight: { enabled: false } } })).run(['meeting', 'start', '--session', 'lead'], { platform: 'win32', processes: off });
    assert.ok(!quiet.stdout.some((line) => line.includes('SPOTLI')), quiet.stdout.join('\n'));
    assert.deepEqual(off.hidden, []);

    const linux = new FakeProcesses();
    const refused = await (await teamBeforeTheMeeting(SPOTLIT_TEAM)).run(['meeting', 'start', '--session', 'lead'], { processes: linux });
    assert.ok(!refused.stdout.some((line) => line.includes('SPOTLI')), refused.stdout.join('\n'));
    assert.deepEqual(linux.hidden, []);
  });

  it('prints the agenda before the first meeting, during one, after its end and after it lapsed', async () => {
    const kit = await teamBeforeTheMeeting();
    const first = await kit.run(['meeting', 'agenda', '--session', 'lead']);
    assert.equal(first.code, EXIT.ok, first.stderr.join('\n'));
    assert.equal(first.stdout[0], 'MEETING none held yet; the agenda for the first (teamrig meeting start opens it)');
    assert.equal(first.stdout[2], 'DECISIONS 1 waiting on owner (decision or approval)');

    await kit.run(['meeting', 'start', '--session', 'lead']);
    assert.equal((await kit.run(['meeting', 'agenda', '--session', 'lead'])).stdout[0], 'MEETING open since Tue 01-08 10:00 UTC: messages to app-lead are held but CRITICAL ones');

    kit.clock.advance(30 * MINUTE);
    await kit.run(['meeting', 'end', '--session', 'lead']);
    assert.equal((await kit.run(['meeting', 'agenda', '--session', 'lead'])).stdout[0], 'MEETING none open, the last ended Tue 01-08 10:30 UTC; the agenda for the next (teamrig meeting start opens it)');

    kit.clock.advance(MEETING_LAPSE_MS);
    await kit.run(['meeting', 'start', '--session', 'lead']);
    kit.clock.advance(MEETING_LAPSE_MS);
    assert.equal(
      (await kit.run(['meeting', 'agenda', '--session', 'lead'])).stdout[0],
      'MEETING the one started Tue 01-08 14:30 UTC was never ended and holds no message since Tue 01-08 18:30 UTC; teamrig meeting end tells each session the decisions on its tasks',
    );
  });

  it('counts the finished work from the meeting before', async () => {
    const kit = await teamBeforeTheMeeting();
    await kit.run(['meeting', 'start', '--session', 'lead']);
    kit.clock.advance(30 * MINUTE);
    await kit.run(['meeting', 'end', '--session', 'lead']);
    kit.clock.advance(MINUTE);
    await kit.run(['set', 'T2', '--status', 'done', '--note', 'shipped', '--evidence', 'the docs are live', '--skill', 'none', '--followups', 'none', '--session', 'bravo']);
    kit.clock.advance(20 * 60 * MINUTE);
    const next = await kit.run(['meeting', 'start', '--session', 'lead']);
    const done = next.stdout.indexOf('DONE 1 done, 0 dropped since Tue 01-08 10:30 UTC');
    assert.ok(done > 0, next.stdout.join('\n'));
    assert.equal(next.stdout[done + 1], '  Other work 1: teamrig list --status done');
  });

  it("ends: tells only a session with the lead's decisions on its tasks, with them", async () => {
    const kit = await teamBeforeTheMeeting();
    await kit.run(['meeting', 'start', '--session', 'lead']);
    await inboxOf(kit, 'alpha');
    await inboxOf(kit, 'bravo');
    kit.clock.advance(25 * MINUTE);
    const decided = await kit.run(['update', 'T1', '--note', 'owner decided: the middle tier', '--priority', 'p2', '--session', 'lead']);
    assert.equal(decided.code, EXIT.ok, decided.stderr.join('\n'));
    const ended = await kit.run(['meeting', 'end', '--session', 'lead']);
    assert.equal(ended.code, EXIT.ok, ended.stderr.join('\n'));
    assert.deepEqual(ended.stdout, [
      'MEETING ended Tue 01-08 10:25 UTC after 25 min: messages to app-lead go again; told 1 session(s) the decisions on their tasks',
      "RECORDED 1 decision(s), each told to its task's owner",
      '  alpha T1: owner decided: the middle tier (changed priority)',
    ]);
    const alpha = await inboxOf(kit, 'alpha');
    assert.ok(alpha.some((line) => line.endsWith("lead: the owner's daily meeting with app-lead ended Tue 01-08 10:25 UTC. Decided on your tasks: T1: owner decided: the middle tier (changed priority).")), alpha.join('\n'));
    const bravo = await inboxOf(kit, 'bravo');
    assert.ok(!bravo.some((line) => line.includes('daily meeting')), bravo.join('\n'));
  });

  it('ends a meeting with nothing recorded: posts no line, and says a decision the register lacks reaches no one', async () => {
    const kit = await teamBeforeTheMeeting();
    await kit.run(['meeting', 'start', '--session', 'lead']);
    const ended = await kit.run(['meeting', 'end', '--session', 'lead']);
    assert.match(ended.stdout[0] ?? '', /: messages to app-lead go again; told 0 session\(s\) the decisions on their tasks$/);
    for (const session of ['alpha', 'bravo']) {
      const lines = await inboxOf(kit, session);
      assert.ok(!lines.some((line) => line.includes('daily meeting')), lines.join('\n'));
    }
    assert.equal(ended.stdout[1], 'RECORDED nothing on another session\'s task during it: a decision the register lacks reaches no one (teamrig update <id> --decided --note "..." --session lead)');
  });

  it('ends a lapsed meeting, and refuses with none open', async () => {
    const kit = await teamBeforeTheMeeting();
    const none = await kit.run(['meeting', 'end', '--session', 'lead']);
    assert.deepEqual([none.code, none.stdout], [EXIT.refused, ['REFUSED no meeting is open; teamrig meeting start opens one']]);
    await kit.run(['meeting', 'start', '--session', 'lead']);
    kit.clock.advance(MEETING_LAPSE_MS + MINUTE);
    assert.equal((await kit.run(['meeting', 'end', '--session', 'lead'])).code, EXIT.ok);
    assert.equal((await kit.run(['meeting', 'end', '--session', 'lead'])).code, EXIT.refused);
  });

  it('names a session it could not tell, and goes on', async () => {
    const kit = await teamBeforeTheMeeting({ ...TEAM, register: { secretPatterns: ['daily meeting'] } });
    await kit.run(['meeting', 'start', '--session', 'lead']);
    await kit.run(['update', 'T1', '--note', 'owner decided: go', '--session', 'lead']);
    const ended = await kit.run(['meeting', 'end', '--session', 'lead']);
    assert.equal(ended.code, EXIT.ok, ended.stderr.join('\n'));
    assert.match(ended.stdout[0] ?? '', /^NOT TOLD alpha: the line looks like it holds a secret/);
    assert.match(ended.stdout[1] ?? '', /told 0 session\(s\)/);
  });

  it('puts a card off with update --later, out of DECISIONS into LATER, and brings it back with --later none (T1295)', async () => {
    const kit = await teamBeforeTheMeeting();
    const later = await kit.run(['update', 'T1', '--later', '2030-01-09 09:00', '--note', 'owner: after the demo', '--session', 'lead']);
    assert.equal(later.code, EXIT.ok, later.stderr.join('\n'));
    assert.match(later.stdout[0] ?? '', /^UPDATED T1 waiting, /);
    const putOff = (await kit.run(['meeting', 'agenda', '--session', 'lead'])).stdout;
    const at = putOff.findIndex((line) => line.startsWith('LATER 1 put off by owner'));
    assert.ok(at > 0, putOff.join('\n'));
    assert.match(putOff[at + 1] ?? '', /^ {2}T1 waiting, Improvements, score 3\.33, p1, owner alpha \| Pick the pricing tier/);
    assert.ok(!putOff.some((line) => line.startsWith('DECISIONS 1')), putOff.join('\n'));
    const back = await kit.run(['update', 'T1', '--later', 'none', '--note', 'owner: asks now', '--session', 'alpha']);
    assert.equal(back.code, EXIT.ok, back.stderr.join('\n'));
    const asked = (await kit.run(['meeting', 'agenda', '--session', 'lead'])).stdout;
    assert.equal(asked[2], 'DECISIONS 1 waiting on owner (decision or approval)');
    assert.ok(!asked.some((line) => line.startsWith('LATER')), asked.join('\n'));
  });

  it('takes --later with a --note alone, a time to come, and refuses a peer, writing nothing (T1295)', async () => {
    const kit = await teamBeforeTheMeeting();
    const usages: [readonly string[], RegExp][] = [
      [['--later', '2030-01-09', '--priority', 'p2', '--note', 'x'], /^--later puts a card off with a --note alone: it takes no --priority/],
      [['--later', '2030-01-09', '--pin', '--note', 'x'], /^--later puts a card off with a --note alone: it takes no --pin/],
      [['--later', '2030-01-09'], /^--note is required/],
      [['--later', 'soon', '--note', 'x'], /^--later /],
    ];
    for (const [extra, message] of usages) {
      const result = await kit.run(['update', 'T1', ...extra, '--session', 'lead']);
      assert.equal(result.code, EXIT.usage, extra.join(' '));
      assert.match(result.stderr[0] ?? '', message, extra.join(' '));
    }
    const peer = await kit.run(['update', 'T1', '--later', '2030-01-09', '--note', 'x', '--session', 'bravo']);
    assert.deepEqual([peer.code, peer.stdout], [EXIT.refused, ['REFUSED only the owner (alpha) or the lead (lead) puts T1 off']]);
    const passed = await kit.run(['update', 'T1', '--later', '2030-01-08 09:00', '--note', 'x', '--session', 'lead']);
    assert.deepEqual([passed.code, passed.stdout], [EXIT.refused, ['REFUSED time 01-08 09:00 UTC has passed: name a time to come']]);
    assert.equal((await kit.run(['meeting', 'agenda', '--session', 'lead'])).stdout[2], 'DECISIONS 1 waiting on owner (decision or approval)');
  });

  it("records the owner's answer with update --decided: the card leaves the agenda, and its owner sees it decided (T1366)", async () => {
    const kit = await teamBeforeTheMeeting();
    const decided = await kit.run(['update', 'T1', '--decided', '--note', 'owner decided: the middle tier', '--session', 'lead']);
    assert.equal(decided.code, EXIT.ok, decided.stderr.join('\n'));
    assert.match(decided.stdout[0] ?? '', /^UPDATED T1 waiting, .*owner decided, by lead/);
    const agenda = (await kit.run(['meeting', 'agenda', '--session', 'lead'])).stdout;
    assert.deepEqual(agenda.slice(2, 4), ['DECISIONS 0 waiting on owner (decision or approval)', 'LATE 1 past their due date'], agenda.join('\n'));
    const shown = (await kit.run(['show', 'T1', '--session', 'alpha'])).stdout.join('\n');
    assert.match(shown, /^decided: lead at 2030-01-08 10:00 UTC: owner decided: the middle tier$/m);
  });

  it('takes --decided with a --note alone, on a card waiting on the owner, from its owner or a leader, writing nothing else (T1366)', async () => {
    const kit = await teamBeforeTheMeeting();
    const usages: [readonly string[], RegExp][] = [
      [['--decided', '--priority', 'p2', '--note', 'x'], /^--decided records the owner's answer with a --note alone: it takes no --priority/],
      [['--decided', '--later', '2030-01-09', '--note', 'x'], /^--decided records the owner's answer with a --note alone: it takes no --later/],
      [['--decided', '--pin', '--note', 'x'], /^--decided records the owner's answer with a --note alone: it takes no --pin/],
      [['--decided'], /^--note is required/],
    ];
    for (const [extra, message] of usages) {
      const result = await kit.run(['update', 'T1', ...extra, '--session', 'lead']);
      assert.equal(result.code, EXIT.usage, extra.join(' '));
      assert.match(result.stderr[0] ?? '', message, extra.join(' '));
    }
    const peer = await kit.run(['update', 'T1', '--decided', '--note', 'x', '--session', 'bravo']);
    assert.deepEqual([peer.code, peer.stdout], [EXIT.refused, ['REFUSED only the owner (alpha) or the lead (lead) records a decision on T1']]);
    const late = await kit.run(['update', 'T2', '--decided', '--note', 'x', '--session', 'lead']);
    assert.deepEqual([late.code, late.stdout], [EXIT.refused, ['REFUSED T2 waits on no decision or approval of owner: only such a card is decided']]);
    assert.equal((await kit.run(['meeting', 'agenda', '--session', 'lead'])).stdout[2], 'DECISIONS 1 waiting on owner (decision or approval)');
  });

  it('opens with a row per ranked goal, its done count read from the history (T2092)', async () => {
    const kit = new CliHarness(TEAM);
    const run = async (args: readonly string[]): Promise<void> => {
      const result = await kit.run(args);
      assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    };
    await run(['goal', 'add', 'G1', '--title', 'Ship the beta', '--target', '2030-02-01', '--session', 'lead']);
    await run(['goal', 'rank', 'G1', '1', '--session', 'lead']);
    for (const title of ['Build the page', 'Write the copy']) {
      await run(['add', '--owner', 'alpha', '--title', title, '--description', 'what and why', '--priority', 'p2', '--goals', 'G1', '--session', 'lead']);
    }
    await run(['set', 'T1', '--status', 'done', '--note', 'shipped', '--evidence', 'the page is live', '--skill', 'none', '--followups', 'none', '--session', 'alpha']);
    await run(['set', 'T2', '--status', 'waiting', '--waits', 'time:2030-01-09 09:00', '--note', 'after the demo', '--session', 'alpha']);
    const { stdout } = await kit.run(['meeting', 'agenda', '--session', 'lead']);
    assert.equal(stdout[1], 'GOALS 1 ranked, best first: done, spend against size, risk, what waits');
    assert.match(stdout[2] ?? '', /^ {2}#1 G1 Ship the beta \(target 2030-02-01\): 1\/2 done, spent 0\.0% of \d+\.\d% sized, 0 slips, 0 overdue, 1 waiting: T2$/);
  });

  // T1771: the agenda carries the top lines `teamrig stats --tree` prints, from the same fold, so the two never disagree.
  it("prints the stats' top lines below the register's part, as stats --tree prints them, the days at the usage limit marked", async () => {
    const kit = await teamBeforeTheMeeting();
    const period = { start: Date.parse('2030-01-02T00:00:00Z'), end: Date.parse('2030-01-09T00:00:00Z'), w: 0, forecastPct: undefined };
    await new MeterLog(kit.files, join(TEAM_HOME, 'state', 'usage', 'meter-log.jsonl')).append({ ...period, at: Date.parse('2030-01-07T20:00:00Z'), usedPct: 100 }, kit.clock.now());
    const stats = await kit.run(['stats', '--tree', '--session', 'lead']);
    assert.equal(stats.code, EXIT.ok, stats.stderr.join('\n'));
    const limit = 'LIMIT $ 01-07, 01-08: the week sat at its usage limit, so a quiet day there is no slack';
    assert.equal(stats.stdout[3], limit);
    const { stdout } = await kit.run(['meeting', 'agenda', '--session', 'lead']);
    const top = stdout.findIndex((line) => line.startsWith('STATS '));
    assert.deepEqual(stdout.slice(top, top + 4), stats.stdout.slice(0, 4));
    assert.equal(stdout[top + 4], '  each other section: teamrig stats --tree --session lead (new work, speed, delays, waits, bugs, people, goals, areas)');
    assert.ok(stdout.findIndex((line) => line.startsWith('DONE ')) < top, stdout.join('\n'));
  });

  it("prints the planned week's fit under the week's use", async () => {
    const kit = await teamBeforeTheMeeting();
    await kit.run(['add', '--title', 'Write the guide', '--description', 'what and why', '--priority', 'p2', '--week', '2030-01-07', '--size', '20', '--session', 'alpha']);
    const status = JSON.stringify({
      session_id: '0123abcd-0000-4000-8000-0000000000aa',
      cwd: APP,
      workspace: { current_dir: APP },
      rate_limits: { seven_day: { used_percentage: 30, resets_at: Date.parse('2030-01-14T01:00:00Z') / 1000 } },
    });
    assert.equal((await kit.run(['statusline'], { stdin: status })).code, EXIT.ok);
    const { stdout } = await kit.run(['meeting', 'agenda', '--session', 'lead']);
    const week = stdout.findIndex((line) => line.startsWith('Week: '));
    assert.equal(stdout[week + 1], '  fits: p2 20% (left 69.5% of the week)', stdout.join('\n'));
  });

  it("lists merge's self-merges since the meeting before under pushToProtected gated, check-clean ones marked", async () => {
    const landed: SelfMerge = {
      at: '2030-01-08T09:00:00.000Z',
      session: 'alpha',
      repo: 'app',
      branch: 't1-auth',
      task: 'T1',
      base: 'b'.repeat(40),
      head: 'h'.repeat(40),
      tree: 'e'.repeat(40),
      files: 1,
      lines: 6,
      checks: ['unit'],
      review: 'checked',
      route: 'self',
    };
    const gated = await teamBeforeTheMeeting({ ...TEAM, pushGuard: { pushToProtected: 'gated' } });
    await new MergeLog(gated.files, join(TEAM_HOME, 'state', 'deploys', 'merges.jsonl')).append(landed);
    const { stdout } = await gated.run(['meeting', 'agenda', '--session', 'lead']);
    const merges = stdout.findIndex((line) => line.startsWith('MERGES '));
    assert.deepEqual(stdout.slice(merges, merges + 2), [
      'MERGES 1 merged with no approval since Mon 01-07 10:00 UTC, 1 CHECK-CLEAN (security samples those weekly)',
      '  Tue 01-08 09:00 UTC alpha app t1-auth bbbbbbbb..hhhhhhhh: 1 files, 6 lines, checks unit, CHECK-CLEAN',
    ]);
    assert.ok(stdout.indexOf('DONE 0 done, 0 dropped since Mon 01-07 10:00 UTC') < merges, stdout.join('\n'));
    const plain = await teamBeforeTheMeeting();
    assert.ok(!(await plain.run(['meeting', 'agenda', '--session', 'lead'])).stdout.some((line) => line.startsWith('MERGES ')));
  });

  // T2457: a child team's self-merges reach the root lead's meeting; a log teams share is read once.
  it("lists the self-merges of each team under the lead after its own, by <team>/<session>, reading a shared log once", async () => {
    const landed = (session: string, branch: string): SelfMerge => ({
      at: '2030-01-08T09:00:00.000Z',
      session,
      repo: 'app',
      branch,
      task: 'T1',
      base: 'b'.repeat(40),
      head: 'h'.repeat(40),
      tree: 'e'.repeat(40),
      files: 1,
      lines: 6,
      checks: ['unit'],
      review: 'untouched',
      route: 'self',
    });
    const kit = await treeHarness({ pushGuard: { pushToProtected: 'gated' } });
    const rootDeploys = join(TEAM_HOME, 'state', 'deploys');
    await kit.files.write(teamConfigOf('ops'), formatConfig({ ...SUB_TEAMS['ops'], delivery: { dir: rootDeploys } }));
    const rootLog = new MergeLog(kit.files, join(rootDeploys, 'merges.jsonl'));
    await rootLog.append(landed('alpha', 't1-root'));
    await rootLog.append(landed('run', 't2-shared'));
    await new MergeLog(kit.files, join(teamHomeOf('web'), 'state', 'deploys', 'merges.jsonl')).append(landed('front', 't3-web'));
    const { stdout } = await kit.run(['meeting', 'agenda', '--session', 'lead']);
    const merges = stdout.findIndex((line) => line.startsWith('MERGES '));
    assert.deepEqual(stdout.slice(merges, merges + 4), [
      'MERGES 3 merged with no approval since Mon 01-07 10:00 UTC, 0 CHECK-CLEAN (security samples those weekly)',
      '  Tue 01-08 09:00 UTC alpha app t1-root bbbbbbbb..hhhhhhhh: 1 files, 6 lines, checks unit',
      '  Tue 01-08 09:00 UTC run app t2-shared bbbbbbbb..hhhhhhhh: 1 files, 6 lines, checks unit',
      '  Tue 01-08 09:00 UTC web/front app t3-web bbbbbbbb..hhhhhhhh: 1 files, 6 lines, checks unit',
    ]);
    assert.equal(stdout.filter((line) => line.includes(' t2-shared ')).length, 1, stdout.join('\n'));
  });
});
