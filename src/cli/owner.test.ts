import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readEvents } from '../register/snapshot.ts';
import { APP, CLAUDE_SESSION, CliHarness, EVENTS_PATH, TEAM_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { ok } from '../testing/hired-team.ts';
import { teamEventsOf, teamHomeOf, teamInboxOf, treeHarness } from '../testing/team-tree.ts';
import { WakeAsks } from '../wake/asks.ts';
import { ownerNextLeadLine, ownerNextLine, ownerNoteLine } from './commands/owner.ts';
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

  it('refuses a dropped task and a blank Note, telling nobody, and takes no --session', async () => {
    const kit = await team();
    ok(await kit.run(['set', 'T1', '--status', 'dropped', '--note', 'not needed', '--session', 'alpha']));
    const before = kit.files.get(EVENTS_PATH);
    assertRefused(await kit.run(['owner', 'note', 'T1', '--text', 'why?']), /^REFUSED T1 is dropped/);
    assertRefused(await kit.run(['owner', 'note', 'T2', '--text', '  ']), /^REFUSED a Note needs --text: what owner tells alpha/);
    assertRefused(await kit.run(['owner', 'note', 'T2']), /^REFUSED a Note needs --text: what owner tells alpha/);
    assert.equal(kit.files.get(EVENTS_PATH), before);
    assert.deepEqual(await inboxOf(kit, 'alpha'), []);
    assert.equal((await kit.run(['owner', 'note', 'T2', '--text', 'x', '--session', 'lead'])).code, EXIT.usage);
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
