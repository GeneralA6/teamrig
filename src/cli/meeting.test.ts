import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MEETING_LAPSE_MS } from '../meeting/state.ts';
import { TEST_CARD, TEST_GATE, TEST_OWNER_CARD_FLAGS } from '../testing/card.ts';
import { APP, CliHarness, TEAM } from '../testing/cli-harness.ts';
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
    assert.equal(stdout[1], 'DECISIONS 1 waiting on owner (decision or approval)');
    assert.match(stdout[2] ?? '', /^ {2}T1 waiting, p1, owner alpha \| Pick the pricing tier/);
    assert.equal(stdout[3], '    what and why: which tier ships first');
    assert.equal(stdout[4], `    decide: ${TEST_CARD.question}`);
    assert.equal(stdout[5], `    gate: ${TEST_GATE}`);
    assert.ok(stdout.includes('    waiting since 01-08 10:00 UTC: two options'), stdout.join('\n'));
    const late = stdout.indexOf('LATE 1 past their due date');
    assert.match(stdout[late + 1] ?? '', /^ {2}T2 open, p2, owner bravo, due 01-07 \| Ship the docs/);
    assert.ok(stdout.includes('DONE 0 done or dropped since Mon 01-07 10:00 UTC'), stdout.join('\n'));
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

  // T1278: the team's decisions.askWith sets how the lead asks the cards; plain text unless it asks for the picker.
  it('tells the lead to ask in plain text, or with the picker when the team config asks for it', async () => {
    const asks = async (config: typeof TEAM): Promise<string[]> => {
      const { stdout } = await (await teamBeforeTheMeeting(config)).run(['meeting', 'start', '--session', 'lead']);
      return stdout.filter((line) => line.startsWith('  Ask '));
    };
    assert.deepEqual(await asks(TEAM), ["  Ask in plain text, never with the question picker: each card's options numbered, your recommendation first; owner answers in their own words."]);
    assert.deepEqual(await asks({ ...TEAM, decisions: { askWith: 'picker' } }), [
      "  Ask the choices with the question picker (AskUserQuestion), at most 4 a call: each card's options as its choices, your recommendation first.",
    ]);
  });

  it("prints the meeting's times on the team's clock, in its lines and its notices", async () => {
    const kit = await teamBeforeTheMeeting();
    const { stdout } = await kit.run(['meeting', 'start', '--session', 'lead'], { timeZone: 'Asia/Jerusalem' });
    assert.equal(stdout[0], 'MEETING started Tue 01-08 12:00 IST: messages to app-lead are held but CRITICAL ones (the hook tells each sender)');
    assert.ok(stdout.includes('DONE 0 done or dropped since Mon 01-07 12:00 IST'), stdout.join('\n'));
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
    assert.equal(again.stdout[1], 'DECISIONS 1 waiting on owner (decision or approval)');
    assert.match((await inboxOf(kit, 'alpha'))[0] ?? '', /^READ alpha: nothing new/);
  });

  it('prints the agenda before the first meeting, during one, after its end and after it lapsed', async () => {
    const kit = await teamBeforeTheMeeting();
    const first = await kit.run(['meeting', 'agenda', '--session', 'lead']);
    assert.equal(first.code, EXIT.ok, first.stderr.join('\n'));
    assert.equal(first.stdout[0], 'MEETING none held yet; the agenda for the first (teamrig meeting start opens it)');
    assert.equal(first.stdout[1], 'DECISIONS 1 waiting on owner (decision or approval)');

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
    const done = next.stdout.indexOf('DONE 1 done or dropped since Tue 01-08 10:30 UTC');
    assert.ok(done > 0, next.stdout.join('\n'));
    assert.match(next.stdout[done + 1] ?? '', /^ {2}T2 done/);
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
    assert.equal(ended.stdout[1], 'RECORDED nothing on another session\'s task during it: a decision the register lacks reaches no one (teamrig update <id> --note "..." --session lead)');
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
});
