import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readEvents } from '../register/snapshot.ts';
import { cardDigest } from '../register/card-digest.ts';
import { APP, CLAUDE_SESSION, CliHarness, CONFIG_PATH, EVENTS_PATH, TEAM, TEAM_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { ok } from '../testing/hired-team.ts';
import { teamEventsOf, teamHomeOf, teamInboxOf, treeHarness } from '../testing/team-tree.ts';
import { WakeAsks } from '../wake/asks.ts';
import { TEST_CARD, TEST_CARD_FLAGS, TEST_OWNER_CARD, TEST_OWNER_CARD_FLAGS } from '../testing/card.ts';
import { ownerDecideLine, ownerLaterLine, ownerNextLeadLine, ownerNextLine, ownerNoteLine } from './commands/owner.ts';
import { EXIT } from './runtime.ts';

const ASKS = join(TEAM_HOME, 'state', 'wake-asks');

/** A team whose alpha holds T1 (open) and T2 (open, pinned by the lead), and whose lead holds T3. */
async function team(): Promise<CliHarness> {
  const kit = new CliHarness();
  ok(await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']));
  ok(await kit.run(['add', '--title', 'Fix the hook', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']));
  ok(await kit.run(['add', '--title', 'Plan the week', '--description', 'what and why', '--priority', 'p2', '--session', 'lead']));
  ok(await kit.run(['update', 'T2', '--pin', '--session', 'lead']));
  return kit;
}

/** The inbox lines `session` has, as `inbox read` prints them. */
async function inboxOf(kit: CliHarness, session: string): Promise<string[]> {
  return ok(await kit.run(['inbox', 'read', '--session', session])).stdout.filter((line) => line.startsWith('- '));
}

/** The wake asks waiting for `session`'s tab, as [from, text]. */
async function asksOf(kit: CliHarness, session: string, folder = ASKS): Promise<(string | undefined)[][]> {
  return (await new WakeAsks(kit.files, folder).read(session)).map((stored) => [stored.ask?.from, stored.ask?.text]);
}

/** The last event of the register at `path`, as [by, type, note]. */
function lastEventOf(kit: CliHarness, path = EVENTS_PATH): (string | null | undefined)[] {
  const event = readEvents(kit.files.get(path) ?? '').events.at(-1);
  return [event?.by, event?.type, event?.type === 'update' ? event.note : undefined];
}

/** A refusal prints `REFUSED <why>` and exits 2. */
function assertRefused(result: CliResult, reason: RegExp): void {
  assert.equal(result.code, EXIT.refused, [...result.stdout, ...result.stderr].join('\n'));
  assert.match(result.stdout.join('\n'), reason);
}

describe('teamrig owner note (T1298)', () => {
  it("keeps the Note in the task's history as the owner's and tells the session with no wake on an open task", async () => {
    const kit = await team();
    const result = ok(await kit.run(['owner', 'note', 'T1', '--text', ' drop it if nothing needs it ']));
    assert.deepEqual(result.stdout, ['NOTED T1 open, p2, owner alpha, from alpha | Ship the CLI']);
    assert.deepEqual(lastEventOf(kit), ['owner', 'update', 'drop it if nothing needs it']);
    const line = ownerNoteLine('owner', 'T1', 'drop it if nothing needs it');
    assert.deepEqual(result.stderr, [`NOTE alpha has an inbox line: ${line}`]);
    assert.deepEqual(await inboxOf(kit, 'alpha'), [`- 2030-01-08 10:00 UTC owner: ${line}`]);
    assert.deepEqual(await asksOf(kit, 'alpha'), []);
    assert.deepEqual(await inboxOf(kit, 'lead'), []);
  });

  it('wakes the session when the task is in progress', async () => {
    const kit = await team();
    ok(await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']));
    const result = ok(await kit.run(['owner', 'note', 'T1', '--text', 'the demo is at noon']));
    const line = ownerNoteLine('owner', 'T1', 'the demo is at noon');
    assert.deepEqual(result.stderr, [`NOTE alpha has an inbox line that wakes its idle tab: ${line}`]);
    assert.deepEqual(await asksOf(kit, 'alpha'), [['owner', line]]);
    assert.deepEqual(await inboxOf(kit, 'alpha'), [`- 2030-01-08 10:00 UTC owner: ${line}`]);
  });

  it('refuses a dropped task, a blank Note and a --session naming no session, telling nobody', async () => {
    const kit = await team();
    ok(await kit.run(['set', 'T1', '--status', 'dropped', '--note', 'not needed', '--session', 'alpha']));
    const before = kit.files.get(EVENTS_PATH);
    assertRefused(await kit.run(['owner', 'note', 'T1', '--text', 'why?']), /^REFUSED T1 is dropped/);
    assertRefused(await kit.run(['owner', 'note', 'T2', '--text', '  ']), /^REFUSED a Note needs --text: what owner tells alpha/);
    assertRefused(await kit.run(['owner', 'note', 'T2']), /^REFUSED a Note needs --text: what owner tells alpha/);
    assert.equal(kit.files.get(EVENTS_PATH), before);
    // Every command reads --session (#654); one that writes as the owner checks it names a session and ignores it.
    assertRefused(await kit.run(['owner', 'note', 'T2', '--text', 'x', '--session', 'nobody']), /^REFUSED --session nobody names no session of team app/);
    assert.equal(kit.files.get(EVENTS_PATH), before);
    assert.deepEqual(await inboxOf(kit, 'alpha'), []);
  });
});

describe('teamrig owner next (T1298)', () => {
  it("pins the task as the owner's, moves the session's earlier pin, wakes the session and tells the lead without a wake", async () => {
    const kit = await team();
    const result = ok(await kit.run(['owner', 'next', 'T1']));
    assert.deepEqual(result.stdout, ['NEXT T1 open, p2, pinned, owner alpha, from alpha | Ship the CLI']);
    const events = readEvents(kit.files.get(EVENTS_PATH) ?? '').events.slice(-2);
    assert.deepEqual(
      events.map((event) => [event.by, event.id, event.type === 'update' ? event.changes.pin : undefined]),
      [
        ['owner', 'T2', null],
        ['owner', 'T1', 'owner'],
      ],
    );
    const task = { id: 'T1', owner: 'alpha', title: 'Ship the CLI' };
    const wake = ownerNextLine('owner', 'T1');
    const told = ownerNextLeadLine('owner', task, { task: (id) => id, session: (id) => id });
    assert.deepEqual(result.stderr, [`NOTE alpha has an inbox line that wakes its idle tab: ${wake}`, `NOTE lead has an inbox line: ${told}`]);
    assert.deepEqual(await asksOf(kit, 'alpha'), [['owner', wake]]);
    assert.deepEqual(await inboxOf(kit, 'lead'), [`- 2030-01-08 10:00 UTC owner: ${told}`]);
    assert.deepEqual(await asksOf(kit, 'lead'), []);
  });

  it("sends the lead's own task no second line", async () => {
    const kit = await team();
    const result = ok(await kit.run(['owner', 'next', 'T3']));
    assert.deepEqual(result.stderr, [`NOTE lead has an inbox line that wakes its idle tab: ${ownerNextLine('owner', 'T3')}`]);
    assert.equal((await inboxOf(kit, 'lead')).length, 1);
  });

  it('previews what it would do, naming the pin it moves, and writes nothing', async () => {
    const kit = await team();
    const before = kit.files.get(EVENTS_PATH);
    const result = ok(await kit.run(['owner', 'next', 'T1', '--preview']));
    assert.deepEqual(result.stdout, ["PREVIEW owner next T1: goes to the top of alpha's list (the earlier pin on T2 moves down), alpha is woken, the lead (lead) is told; nothing written"]);
    const own = ok(await kit.run(['owner', 'next', 'T3', '--preview']));
    assert.deepEqual(own.stdout, ["PREVIEW owner next T3: goes to the top of lead's list, lead is woken; nothing written"]);
    assert.equal(kit.files.get(EVENTS_PATH), before);
    assert.deepEqual([...(await inboxOf(kit, 'alpha')), ...(await inboxOf(kit, 'lead'))], []);
    assert.deepEqual(await asksOf(kit, 'alpha'), []);
  });

  it('refuses an in-progress task, a dropped one and one the owner put next already, in the preview too', async () => {
    const kit = await team();
    ok(await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']));
    ok(await kit.run(['set', 'T3', '--status', 'dropped', '--note', 'not needed', '--session', 'lead']));
    ok(await kit.run(['owner', 'next', 'T2']));
    for (const preview of [[], ['--preview']]) {
      assertRefused(await kit.run(['owner', 'next', 'T1', ...preview]), /^REFUSED T1 is in progress: alpha has it in hand already/);
      assertRefused(await kit.run(['owner', 'next', 'T3', ...preview]), /^REFUSED T3 is dropped: only a task still to finish goes next/);
      assertRefused(await kit.run(['owner', 'next', 'T2', ...preview]), /^REFUSED T2 is next already: owner put it there; a Note tells alpha more/);
    }
  });
});

/** What Claude Code sets for an agent's tool call, a script that call runs and a hook command. */
const UNDER_CLAUDE_CODE: RunOptions = { env: { CLAUDECODE: '1' } };

/** `/teamrig <args>` typed in the harness's tab: the plugin's mod runs it with Claude Code's own environment. */
function typed(kit: CliHarness, args: string): Promise<CliResult> {
  return kit.run(['hook', 'slash-command'], { stdin: JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, args, origin: 'composer' }) });
}

describe('teamrig owner where Claude Code runs it (T1780)', () => {
  it("refuses a Note and a Next under CLAUDECODE, writing nothing and telling nobody", async () => {
    const kit = await team();
    const before = kit.files.get(EVENTS_PATH);
    assertRefused(
      await kit.run(['owner', 'note', 'T1', '--text', 'ship it'], UNDER_CLAUDE_CODE),
      /^REFUSED teamrig owner note acts as the owner, so it is refused where Claude Code runs it \(CLAUDECODE is set: an agent's tool call, a script it runs or a hook\); the owner presses Note in the pane or types \/teamrig owner note in a tab$/,
    );
    assertRefused(await kit.run(['owner', 'next', 'T1'], UNDER_CLAUDE_CODE), /^REFUSED teamrig owner next acts as the owner, .*; the owner presses Next in the pane or types \/teamrig owner next in a tab$/);
    assert.equal(kit.files.get(EVENTS_PATH), before);
    assert.deepEqual([...(await inboxOf(kit, 'alpha')), ...(await inboxOf(kit, 'lead'))], []);
    assert.deepEqual([...(await asksOf(kit, 'alpha')), ...(await asksOf(kit, 'lead'))], []);
  });

  it('still previews a Next, which writes nothing, and takes an empty CLAUDECODE as unset', async () => {
    const kit = await team();
    const preview = ok(await kit.run(['owner', 'next', 'T1', '--preview'], UNDER_CLAUDE_CODE));
    assert.match(preview.stdout.join('\n'), /^PREVIEW owner next T1: goes to the top of alpha's list/);
    ok(await kit.run(['owner', 'note', 'T1', '--text', 'ship it'], { env: { CLAUDECODE: '' } }));
    assert.deepEqual(lastEventOf(kit), ['owner', 'update', 'ship it']);
  });

  it('writes a Note and a Next the owner types as /teamrig in a tab', async () => {
    const kit = await team();
    const noted = ok(await typed(kit, 'owner note T1 --text "the demo is at noon"'));
    assert.match(noted.stdout.join('\n'), /^NOTED T1 /);
    assert.deepEqual(lastEventOf(kit), ['owner', 'update', 'the demo is at noon']);
    const next = ok(await typed(kit, 'owner next T1'));
    assert.match(next.stdout.join('\n'), /^NEXT T1 open, p2, pinned, /);
    assert.deepEqual(await asksOf(kit, 'alpha'), [['owner', ownerNextLine('owner', 'T1')]]);
  });
});

describe("teamrig owner on another team's task (T1298)", () => {
  it("writes in that team's register, wakes its session there and tells that team's lead, naming the task <team>/T<id>", async () => {
    const kit = await treeHarness();
    ok(await kit.run(['add', '--title', 'Ship login', '--description', 'what and why', '--priority', 'p2', '--session', 'front'], { env: { TEAMRIG_TEAM: 'web' } }));
    const preview = ok(await kit.run(['owner', 'next', 'web/T1', '--preview']));
    assert.deepEqual(preview.stdout, ["PREVIEW owner next web/T1: goes to the top of web/front's list, web/front is woken, the lead (web/lead) is told; nothing written"]);
    const result = ok(await kit.run(['owner', 'next', 'web/T1']));
    assert.deepEqual(result.stdout, ['NEXT web/T1 open, p2, pinned, owner front, from front | Ship login']);
    assert.deepEqual(lastEventOf(kit, teamEventsOf('web')), ['owner', 'update', null]);
    assert.equal(kit.files.get(EVENTS_PATH), undefined);
    const wake = ownerNextLine('owner', 'web/T1');
    assert.deepEqual(await asksOf(kit, 'front', join(teamHomeOf('web'), 'state', 'wake-asks')), [['owner', wake]]);
    assert.match(kit.files.get(teamInboxOf('web', 'front')) ?? '', new RegExp(`owner: ${wake}\\n$`));
    assert.match(kit.files.get(teamInboxOf('web', 'lead')) ?? '', /owner: owner put web\/T1 next on web\/front's list: Ship login\n$/);
    const noted = ok(await kit.run(['owner', 'note', 'web/T1', '--text', 'ship it before the demo']));
    assert.match(noted.stdout[0] ?? '', /^NOTED web\/T1 /);
    assert.deepEqual(lastEventOf(kit, teamEventsOf('web')), ['owner', 'update', 'ship it before the demo']);
  });
});

/** team() with alpha's T1 waiting on the owner's decision and T2 on the owner's approval, each with its card. */
async function asking(): Promise<CliHarness> {
  const kit = await team();
  for (const [id, wait, card] of [['T1', 'decision:owner', TEST_OWNER_CARD_FLAGS], ['T2', 'approval:owner', TEST_CARD_FLAGS]] as const) {
    ok(await kit.run(['set', id, '--status', 'waiting', '--waits', wait, '--note', 'the owner picks', ...card, '--session', 'alpha']));
  }
  return kit;
}

describe('teamrig owner decide (#1517)', () => {
  it("records the owner's option as a Decided, dropping the wait on the owner, and wakes the session", async () => {
    const kit = await asking();
    const result = ok(await kit.run(['owner', 'decide', 'T1', '--option', '2', '--note', 'launch with the bigger plan']));
    assert.match(result.stdout[0] ?? '', /^DECIDED T1 waiting, p2, owner alpha, /);
    // The stored note names the option by number (the card keeps its text); the session's line quotes the text too.
    assert.deepEqual(lastEventOf(kit), ['owner', 'update', 'owner decided: option 2; launch with the bigger plan']);
    const line = ownerDecideLine('owner', 'T1', `option 2: ${TEST_CARD.options[1]}; launch with the bigger plan`);
    assert.deepEqual(result.stderr, [`NOTE alpha has an inbox line that wakes its idle tab: ${line}`]);
    assert.deepEqual(await asksOf(kit, 'alpha'), [['owner', line]]);
    const shown = ok(await kit.run(['show', 'T1', '--session', 'lead'])).stdout[0] ?? '';
    assert.match(shown, /\(waiting: owner decided, by owner; /, 'the wait on the owner is gone: the task reads decided');
  });

  it("judges the owner's own words against the room the note leaves them, never the card's option text (#1751 review)", async () => {
    const kit = await team();
    const long = `Pro at 29 dollars a month ${'with the yearly plan '.repeat(7)}`.trim();
    ok(await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'the owner picks', ...TEST_CARD_FLAGS.slice(0, 2), '--options', `${TEST_CARD.options[0]} | ${long}`, ...TEST_CARD_FLAGS.slice(4), '--gate', 'budget', '--session', 'alpha']));
    const before = kit.files.get(EVENTS_PATH);
    // `owner decided: option 2; ` takes 25 of the 300 characters register.maxText allows.
    assertRefused(await kit.run(['owner', 'decide', 'T1', '--option', '2', '--note', 'x'.repeat(276)]), /^REFUSED --note takes at most 275 characters here: the note starts "owner decided: option 2; " and the limit is 300$/);
    assert.equal(kit.files.get(EVENTS_PATH), before);
    const words = 'w'.repeat(140);
    ok(await kit.run(['owner', 'decide', 'T1', '--option', '2', '--note', words]));
    assert.deepEqual(lastEventOf(kit), ['owner', 'update', `owner decided: option 2; ${words}`]);
    assert.deepEqual(await asksOf(kit, 'alpha'), [['owner', ownerDecideLine('owner', 'T1', `option 2: ${long}; ${words}`)]]);
  });

  it('answers an approval with --approve or --decline, each with or without a note', async () => {
    const approved = await asking();
    ok(await approved.run(['owner', 'decide', 'T2', '--approve']));
    assert.deepEqual(lastEventOf(approved), ['owner', 'update', 'owner decided: approved']);
    assert.deepEqual(await asksOf(approved, 'alpha'), [['owner', ownerDecideLine('owner', 'T2', 'approved')]]);
    const declined = await asking();
    ok(await declined.run(['owner', 'decide', 'T2', '--decline', '--note', 'not this month']));
    assert.deepEqual(lastEventOf(declined), ['owner', 'update', 'owner decided: declined; not this month']);
  });

  it('refuses a task not waiting on the owner, an option the card lacks, an approval answer with no approval wait, and a bad answer shape, writing nothing', async () => {
    const kit = await asking();
    const before = kit.files.get(EVENTS_PATH);
    assertRefused(await kit.run(['owner', 'decide', 'T3', '--option', '1']), /^REFUSED T3 waits on no decision or approval of owner/);
    assertRefused(await kit.run(['owner', 'decide', 'T1', '--option', '3']), /^REFUSED --option takes 1 to 2: T1's card has 2 options/);
    assertRefused(await kit.run(['owner', 'decide', 'T1', '--option', '0']), /^REFUSED --option takes 1 to 2/);
    assertRefused(await kit.run(['owner', 'decide', 'T1', '--approve']), /^REFUSED T1 waits on no approval of owner: --approve answers an approval; choose an option with --option <n>/);
    assert.equal(kit.files.get(EVENTS_PATH), before);
    assert.deepEqual([...(await inboxOf(kit, 'alpha')), ...(await asksOf(kit, 'alpha')).map(String)], []);
    for (const args of [[], ['--option', '1', '--approve'], ['--approve', '--decline'], ['--option', 'two']]) {
      assert.equal((await kit.run(['owner', 'decide', 'T1', ...args])).code, EXIT.usage, args.join(' '));
    }
    // Main now reads --session on every command (as owner note's spec shows); an unknown name is refused, writing nothing.
    assertRefused(await kit.run(['owner', 'decide', 'T1', '--option', '1', '--session', 'nobody']), /^REFUSED --session nobody names no session of team app/);
    assert.equal(kit.files.get(EVENTS_PATH), before);
  });
});

describe('teamrig owner decide: the card read and its security verdict (#1751 review)', () => {
  it('binds the answer to the card read with --read, refusing a digest the card no longer has and a bad one, writing nothing', async () => {
    const kit = await asking();
    const before = kit.files.get(EVENTS_PATH);
    const old = cardDigest({ ...TEST_OWNER_CARD, recommend: 'Pro, the bigger launch' });
    assertRefused(
      await kit.run(['owner', 'decide', 'T1', '--option', '2', '--read', old]),
      /^REFUSED --read [0-9a-f]{8} is not T1's card as it stands \(now [0-9a-f]{8}\): its question, options or recommendation changed since it was read/,
    );
    assert.equal((await kit.run(['owner', 'decide', 'T1', '--option', '2', '--read', 'abc'])).code, EXIT.usage);
    assert.equal(kit.files.get(EVENTS_PATH), before);
    assert.deepEqual(await asksOf(kit, 'alpha'), []);
    ok(await kit.run(['owner', 'decide', 'T1', '--option', '2', '--read', cardDigest(TEST_OWNER_CARD)]));
    assert.deepEqual(lastEventOf(kit), ['owner', 'update', 'owner decided: option 2']);
  });

  it('refuses a card whose gate became a security gate while it sat on the owner, writing nothing', async () => {
    const kit = await team();
    ok(await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'the owner picks', ...TEST_OWNER_CARD_FLAGS, '--session', 'alpha']));
    // budget is no security gate by default, so the card reached the owner with no verdict; the team then names it one.
    await kit.files.write(CONFIG_PATH,JSON.stringify({ ...TEAM, securityGates: ['budget'] }));
    const before = kit.files.get(EVENTS_PATH);
    assertRefused(
      await kit.run(['owner', 'decide', 'T1', '--option', '1']),
      /^REFUSED T1's card asks owner about budget, a security gate \[securityGates\], and has no security verdict: owner decides it only with one \(core rule 9\)/,
    );
    assert.equal(kit.files.get(EVENTS_PATH), before);
    assert.deepEqual(await asksOf(kit, 'alpha'), []);
  });
});

describe('teamrig owner later (#1517)', () => {
  it("puts the card off as a Later written as the owner's and tells the session without a wake", async () => {
    const kit = await asking();
    const result = ok(await kit.run(['owner', 'later', 'T1', '--until', '2030-01-10 09:00', '--note', 'after the board call']));
    assert.match(result.stdout[0] ?? '', /^LATER T1 waiting, p2, owner alpha, /);
    const [by, type, note] = lastEventOf(kit);
    assert.deepEqual([by, type], ['owner', 'update']);
    assert.match(String(note), /^owner put the card off until .+; after the board call$/);
    const line = ownerLaterLine('owner', 'T1', 'Thu 01-10 09:00 UTC');
    assert.deepEqual(await inboxOf(kit, 'alpha'), [`- 2030-01-08 10:00 UTC owner: ${line}`]);
    assert.deepEqual(await asksOf(kit, 'alpha'), [], 'a Later wakes no one: the session has nothing to do until then');
    assert.match(ok(await kit.run(['show', 'T1', '--session', 'lead'])).stdout[0] ?? '', /\(waiting: decision owner · until Thu 01-10 09:00 UTC/, 'the wait on the owner stays, with the Later beside it');
  });

  it("judges the owner's own words against the room the note leaves them (#1751 review)", async () => {
    const kit = await asking();
    const before = kit.files.get(EVENTS_PATH);
    const until = ['--until', '2030-01-10 09:00'];
    // `owner put the card off until Thu 01-10 09:00 UTC; ` takes 50 of the 300 characters.
    assertRefused(await kit.run(['owner', 'later', 'T1', ...until, '--note', 'x'.repeat(251)]), /^REFUSED --note takes at most 250 characters here: the note starts "owner put the card off until Thu 01-10 09:00 UTC; " and the limit is 300$/);
    assert.equal(kit.files.get(EVENTS_PATH), before);
    ok(await kit.run(['owner', 'later', 'T1', ...until, '--note', 'y'.repeat(250)]));
    assert.deepEqual(lastEventOf(kit), ['owner', 'update', `owner put the card off until Thu 01-10 09:00 UTC; ${'y'.repeat(250)}`]);
  });

  it('refuses a task not waiting on the owner, a time gone by and a missing --until, writing nothing', async () => {
    const kit = await asking();
    const before = kit.files.get(EVENTS_PATH);
    assertRefused(await kit.run(['owner', 'later', 'T3', '--until', '2030-01-10 09:00']), /^REFUSED T3 waits on no decision or approval of owner/);
    assertRefused(await kit.run(['owner', 'later', 'T1', '--until', '2030-01-07 09:00']), /^REFUSED /);
    assert.equal((await kit.run(['owner', 'later', 'T1'])).code, EXIT.usage);
    assert.equal(kit.files.get(EVENTS_PATH), before);
    assert.deepEqual(await inboxOf(kit, 'alpha'), []);
  });
});

describe('teamrig owner decide and later where Claude Code runs them (#1517)', () => {
  it('refuses both under CLAUDECODE, writing nothing, and writes them when the owner types /teamrig in a tab', async () => {
    const kit = await asking();
    const before = kit.files.get(EVENTS_PATH);
    assertRefused(await kit.run(['owner', 'decide', 'T1', '--option', '1'], UNDER_CLAUDE_CODE), /^REFUSED teamrig owner decide acts as the owner, .*; the owner presses Decide in the pane or types \/teamrig owner decide in a tab$/);
    assertRefused(await kit.run(['owner', 'later', 'T1', '--until', '2030-01-10 09:00'], UNDER_CLAUDE_CODE), /^REFUSED teamrig owner later acts as the owner, .*; the owner presses Later in the pane or types \/teamrig owner later in a tab$/);
    assert.equal(kit.files.get(EVENTS_PATH), before);
    assert.match(ok(await typed(kit, 'owner decide T1 --option 1')).stdout.join('\n'), /^DECIDED T1 /);
    assert.deepEqual(lastEventOf(kit), ['owner', 'update', 'owner decided: option 1']);
  });
});
