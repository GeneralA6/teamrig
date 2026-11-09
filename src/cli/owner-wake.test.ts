import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { projectTranscriptPath } from '../budget/discover.ts';
import type { CommitCharge } from '../delivery/memory.ts';
import { inboxLineOf } from '../inbox/inbox.ts';
import { lineHash } from '../inbox/line-hash.ts';
import { SessionLog, type CloseRecord } from '../sessions/log.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, USER_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakePathProbe, FakeProcesses } from '../testing/fake-processes.ts';
import { ok } from '../testing/hired-team.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { teamHomeOf, teamInboxOf, treeHarness } from '../testing/team-tree.ts';
import { WakeAsks, type StoredWakeAsk } from '../wake/asks.ts';
import { ownerWakeLine } from './commands/owner-wake.ts';
import { EXIT } from './runtime.ts';

const HOUR_MS = 3_600_000;
const MB = 2 ** 20;
const LOG = join(TEAM_HOME, 'state', 'session-log.jsonl');
const TRANSCRIPT = projectTranscriptPath(join(USER_HOME, '.claude', 'projects'), APP, CLAUDE_SESSION);
const CHARGE: CommitCharge = { usedMb: 40_000, limitMb: 100_700 };
/** Alpha, closed by the lead in Claude Code session CLAUDE_SESSION, small and recent enough that `open` resumes it. */
const CLOSED: CloseRecord = { kind: 'close', session: 'alpha', by: 'lead', at: '2030-01-08T08:00:00.000Z', claudeSession: CLAUDE_SESSION, idleMinutes: 75, freedMb: 1300 };
/** The woken session's Claude Code, as its start recorded it and the host lists it while it runs. */
const CLAUDE_PID = 8100;
const RUNNING = [{ pid: CLAUDE_PID, parent: 8000, bytes: 1100 * MB }];
const WAKES_ALPHA = 'WAKES app-alpha (session alpha) within about 15 s: an inbox line from owner asks it to work its task list in plan order';

/** A transcript line the way Claude Code writes an assistant reply, with `tokens` of context: the turn ended. */
function reply(tokens: number): string {
  return `${JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', usage: { input_tokens: 2, cache_read_input_tokens: tokens - 2, output_tokens: 50 } } })}\n`;
}

/** The last entries of a busy tab, each with the clause its refusal names. */
const BUSY: readonly (readonly [string, string])[] = [
  [JSON.stringify({ type: 'user', uuid: 'u1', isSidechain: false, message: { role: 'user', content: 'ship it' } }), 'is in a turn'],
  [JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] } }), 'is at a tool call (running, or waiting on a permission or an answer)'],
  [JSON.stringify({ type: 'assistant', uuid: 'a1', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'Two ways.\nDecision needed: a or b?' }] } }), 'put a decision to the person and waits for the answer'],
];

/** The options of a host where `rows` run (none: the session does not), a new tab opens, and the transcript reads `transcript`. */
async function hostOf(kit: CliHarness, rows: readonly { pid: number; parent: number; bytes: number }[], transcript = reply(40_000)): Promise<{ options: RunOptions; processes: FakeProcesses }> {
  await kit.files.write(TRANSCRIPT, transcript);
  const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started', end: 'exited' });
  const transcripts = new MemoryTranscripts({ [TRANSCRIPT]: transcript }, Date.parse(CLOSED.at) - 2 * HOUR_MS);
  return { processes, options: { platform: 'win32', probe: new FakePathProbe({ folders: [APP] }), memory: new FakeHostMemory().lists(rows, CHARGE), processes, transcripts } };
}

/** Session `id`'s start record in the team home `home`, naming the Claude Code process `RUNNING` lists. */
async function running(kit: CliHarness, id = 'alpha', home = TEAM_HOME): Promise<void> {
  await new SessionRecordStore(kit.files, { sessions: join(home, 'state', 'sessions') }).write(id, { claudePid: CLAUDE_PID, claudeSession: CLAUDE_SESSION, at: '2030-01-08T08:00:00.000Z' });
}

/** The wake asks waiting for `id`'s tab in the team home `home`. */
function asksOf(kit: CliHarness, id: string, home = TEAM_HOME): Promise<readonly StoredWakeAsk[]> {
  return new WakeAsks(kit.files, join(home, 'state', 'wake-asks')).read(id);
}

/** The inbox lines `id` has that `owner wake` posts. */
async function wakeLinesOf(kit: CliHarness, id: string): Promise<string[]> {
  return ok(await kit.run(['inbox', 'read', '--session', id])).stdout.filter((line) => line.endsWith(ownerWakeLine('owner', id)));
}

/** A refusal prints `REFUSED <why>` and exits 2. */
function assertRefused(result: CliResult, reason: RegExp): void {
  assert.equal(result.code, EXIT.refused, [...result.stdout, ...result.stderr].join('\n'));
  assert.match(result.stdout.join('\n'), reason);
}

describe('teamrig owner wake (T2298)', () => {
  it('wakes an idle running session at once with an inbox line from the owner, opening no tab', async () => {
    const kit = new CliHarness();
    await running(kit);
    const now = kit.clock.now();
    const { options, processes } = await hostOf(kit, RUNNING);
    const result = ok(await kit.run(['owner', 'wake', 'app-alpha'], options));
    assert.deepEqual(result.stdout, [WAKES_ALPHA]);
    assert.deepEqual(processes.started, []);
    const text = ownerWakeLine('owner', 'alpha');
    assert.equal(text, 'owner woke you by hand: work your task list in plan order (teamrig list --session alpha)');
    // The owner waits live on it: due at once, bound to its line, not after wake.batchSeconds.
    const by = { at: now, line: lineHash(inboxLineOf(new Date(now), 'owner', text)) };
    assert.deepEqual((await asksOf(kit, 'alpha')).map(({ ask }) => [ask?.from, ask?.text, ask?.by]), [['owner', text, by]]);
    assert.deepEqual(await wakeLinesOf(kit, 'alpha'), [`- 2030-01-08 10:00 UTC owner: ${text}`]);
  });

  it('posts no second line while its wake ask waits, and wakes again once that one is taken', async () => {
    const kit = new CliHarness();
    await running(kit);
    ok(await kit.run(['owner', 'wake', 'alpha'], (await hostOf(kit, RUNNING)).options));
    kit.clock.advance(20_000);
    const again = ok(await kit.run(['owner', 'wake', 'alpha'], (await hostOf(kit, RUNNING)).options));
    assert.deepEqual(again.stdout, ["ASKED app-alpha (session alpha) at 10:00 UTC: that ask still waits for its tab's next wake check, so no second line was posted"]);
    assert.equal((await asksOf(kit, 'alpha')).length, 1);
    const asks = new WakeAsks(kit.files, join(TEAM_HOME, 'state', 'wake-asks'));
    await asks.remove('alpha', await asks.read('alpha'));
    assert.deepEqual(ok(await kit.run(['owner', 'wake', 'alpha'], (await hostOf(kit, RUNNING)).options)).stdout, [WAKES_ALPHA]);
    assert.equal((await asksOf(kit, 'alpha')).length, 1);
  });

  it('refuses a tab in a turn, at a tool call or with a decision put to the person, posting nothing', async () => {
    for (const [last, clause] of BUSY) {
      const kit = new CliHarness();
      await running(kit);
      const { options, processes } = await hostOf(kit, RUNNING, `${reply(40_000)}${last}\n`);
      const result = await kit.run(['owner', 'wake', 'alpha'], options);
      assert.equal(result.code, EXIT.refused, [...result.stdout, ...result.stderr].join('\n'));
      assert.deepEqual(result.stdout, [`REFUSED app-alpha (session alpha) ${clause}, so nothing was posted: it reads its list once that step ends; post it a Note on its task to add to that`]);
      assert.deepEqual(await asksOf(kit, 'alpha'), []);
      assert.deepEqual(await wakeLinesOf(kit, 'alpha'), []);
      assert.deepEqual(processes.started, []);
    }
  });

  it('opens a session that does not run in a new tab, resuming its last Claude Code session, and posts nothing', async () => {
    const kit = new CliHarness();
    await new SessionLog(kit.files, LOG).append(CLOSED);
    const { options, processes } = await hostOf(kit, []);
    const result = ok(await kit.run(['owner', 'wake', 'alpha'], options));
    assert.match(result.stdout[0] ?? '', /^OPENED app-alpha \(session alpha\) in a new Windows Terminal tab in /);
    assert.equal(processes.started.length, 1);
    assert.ok((processes.started[0]?.args ?? []).includes('--resume'), (processes.started[0]?.args ?? []).join(' '));
    assert.deepEqual(await asksOf(kit, 'alpha'), []);
  });

  it('wakes a session of another team of the tree, posting to that team', async () => {
    const kit = await treeHarness();
    const web = teamHomeOf('web');
    await running(kit, 'front', web);
    const result = ok(await kit.run(['owner', 'wake', 'web/front'], (await hostOf(kit, RUNNING)).options));
    assert.deepEqual(result.stdout, ['WAKES web-front (session web/front) within about 15 s: an inbox line from owner asks it to work its task list in plan order']);
    const text = ownerWakeLine('owner', 'front');
    assert.deepEqual((await asksOf(kit, 'front', web)).map(({ ask }) => ask?.text), [text]);
    assert.ok((kit.files.get(teamInboxOf('web', 'front')) ?? '').includes(`owner: ${text}`));
    assert.deepEqual(await asksOf(kit, 'front'), []);
  });

  it('refuses under CLAUDECODE and on a team with wake.enabled false, writing nothing', async () => {
    const kit = new CliHarness();
    await running(kit);
    const host = await hostOf(kit, RUNNING);
    assertRefused(
      await kit.run(['owner', 'wake', 'alpha'], { ...host.options, env: { CLAUDECODE: '1' } }),
      /^REFUSED teamrig owner wake acts as the owner, .*; the owner presses Wake in the pane or types \/teamrig owner wake in a tab$/,
    );
    const off = new CliHarness({ ...TEAM, wake: { enabled: false } });
    await running(off);
    assertRefused(
      await off.run(['owner', 'wake', 'alpha'], (await hostOf(off, RUNNING)).options),
      /^REFUSED app-alpha \(session alpha\) was not woken: wake\.enabled is false on team app, so no inbox line wakes its tab; type in its tab instead$/,
    );
    for (const each of [kit, off]) {
      assert.deepEqual(await asksOf(each, 'alpha'), []);
      assert.deepEqual(await wakeLinesOf(each, 'alpha'), []);
    }
    assert.deepEqual(host.processes.started, []);
  });

  it('takes one session as <id|name> or <team>/<id|name>', async () => {
    const kit = new CliHarness();
    const { options } = await hostOf(kit, RUNNING);
    assert.equal((await kit.run(['owner', 'wake', 'web/front/x'], options)).code, EXIT.usage);
    assert.equal((await kit.run(['owner', 'wake'], options)).code, EXIT.usage);
    assertRefused(await kit.run(['owner', 'wake', 'nobody'], options), /nobody/);
  });
});
