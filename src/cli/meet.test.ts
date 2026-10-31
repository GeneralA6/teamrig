import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { projectTranscriptPath } from '../budget/discover.ts';
import type { CommitCharge } from '../delivery/memory.ts';
import { decodePrompt, meetAsk, meetPrompt } from '../open/prompt.ts';
import { SessionLog, type CloseRecord } from '../sessions/log.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import { TEST_OWNER_CARD_FLAGS } from '../testing/card.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, USER_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakePathProbe, FakeProcesses } from '../testing/fake-processes.ts';
import { ok } from '../testing/hired-team.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { WakeAsks } from '../wake/asks.ts';
import { EXIT } from './runtime.ts';

const HOUR_MS = 3_600_000;
const MB = 2 ** 20;
const LOG = join(TEAM_HOME, 'state', 'session-log.jsonl');
const SESSIONS = join(TEAM_HOME, 'state', 'sessions');
const ASKS = join(TEAM_HOME, 'state', 'wake-asks');
const TRANSCRIPT = projectTranscriptPath(join(USER_HOME, '.claude', 'projects'), APP, CLAUDE_SESSION);
const CHARGE: CommitCharge = { usedMb: 40_000, limitMb: 100_700 };
/** Alpha, closed by the lead in Claude Code session CLAUDE_SESSION, small and recent enough that `open` resumes it. */
const CLOSED: CloseRecord = { kind: 'close', session: 'alpha', by: 'lead', at: '2030-01-08T08:00:00.000Z', claudeSession: CLAUDE_SESSION, idleMinutes: 75, freedMb: 1300 };
/** Alpha's Claude Code, as its start recorded it and the host lists it. */
const CLAUDE_PID = 8100;

/** A transcript line the way Claude Code writes an assistant reply, with `tokens` of context. */
function reply(tokens: number): string {
  return `${JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', usage: { input_tokens: 2, cache_read_input_tokens: tokens - 2, output_tokens: 50 } } })}\n`;
}

/** A team whose alpha holds T1, waiting on the owner's decision with its card. */
async function alphaWithACard(): Promise<CliHarness> {
  const kit = new CliHarness(TEAM);
  ok(await kit.run(['add', '--title', 'Pick the pricing tier', '--description', 'which tier ships first', '--priority', 'p1', '--session', 'alpha']));
  ok(await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'two options', ...TEST_OWNER_CARD_FLAGS, '--session', 'alpha']));
  return kit;
}

/** The options of a host where alpha's Claude Code is `rows`' process (none: not running) and a new tab opens. */
function hostOf(rows: readonly { pid: number; parent: number; bytes: number }[]): { options: RunOptions; processes: FakeProcesses } {
  const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started', end: 'exited' });
  const transcripts = new MemoryTranscripts({ [TRANSCRIPT]: reply(40_000) }, Date.parse(CLOSED.at) - 2 * HOUR_MS);
  return { processes, options: { platform: 'win32', probe: new FakePathProbe({ folders: [APP] }), memory: new FakeHostMemory().lists(rows, CHARGE), processes, transcripts } };
}

/** The first prompt a tab's launch line carries. */
function promptOf(argv: readonly string[]): string | undefined {
  const encoded = argv[argv.indexOf('--encoded-prompt') + 1];
  return encoded === undefined ? undefined : decodePrompt(encoded);
}

/** A refusal prints `REFUSED <why>` and exits 2. */
function assertRefused(result: CliResult, reason: RegExp): void {
  assert.equal(result.code, EXIT.refused, [...result.stdout, ...result.stderr].join('\n'));
  assert.match(result.stdout.join('\n'), reason);
}

describe('teamrig meet --cards', () => {
  it("prints the caller's cards due on the owner and how to record each answer", async () => {
    const kit = await alphaWithACard();
    const lines = ok(await kit.run(['meet', '--cards', '--session', 'alpha'])).stdout;
    assert.equal(lines[0], 'MEET app-alpha (session alpha): 1 card(s) waiting on owner');
    assert.ok(lines.some((line) => line.startsWith('  T1 waiting, p1, owner alpha | Pick the pricing tier')), lines.join('\n'));
    assert.ok(lines.some((line) => line.startsWith('  Record each answer in the same turn: teamrig set <id> ')), lines.join('\n'));
  });

  it('refuses a session with no card due, naming those the owner put off, and takes no <id|name>', async () => {
    const kit = await alphaWithACard();
    ok(await kit.run(['update', 'T1', '--later', '2030-01-09 09:00', '--note', 'owner: after the demo', '--session', 'lead']));
    assertRefused(await kit.run(['meet', '--cards', '--session', 'alpha']), /^REFUSED app-alpha \(session alpha\) has no card waiting on owner now; put off: T1 until 2030-01-09 09:00$/);
    assertRefused(await kit.run(['meet', '--cards', '--session', 'bravo']), /^REFUSED app-bravo \(session bravo\) has no card waiting on owner now$/);
    const extra = await kit.run(['meet', 'alpha', '--cards', '--session', 'alpha']);
    assert.equal(extra.code, EXIT.usage);
    assert.match(extra.stderr[0] ?? '', /^meet --cards prints the caller's own cards: it takes no "alpha"/);
  });
});

describe('teamrig meet <id|name>', () => {
  it('opens a closed session fresh on the meeting, never in its last Claude Code session, and logs the reopen', async () => {
    const kit = await alphaWithACard();
    await new SessionLog(kit.files, LOG).append(CLOSED);
    await kit.files.write(TRANSCRIPT, reply(40_000));
    const { options, processes } = hostOf([]);
    const result = ok(await kit.run(['meet', 'alpha'], options));
    assert.match(result.stdout[0] ?? '', /^OPENED app-alpha \(session alpha\) in a new Windows Terminal tab in /);
    const argv = processes.started[0]?.args ?? [];
    assert.ok(!argv.includes('--resume'), argv.join(' '));
    assert.equal(promptOf(argv), meetPrompt('app', 'alpha', 'owner'));
    assert.deepEqual((await new SessionLog(kit.files, LOG).read()).records, [CLOSED, { kind: 'reopen', session: 'alpha', at: new Date(kit.clock.now()).toISOString() }]);
  });

  it('wakes a running session with an inbox line from the owner and opens no tab', async () => {
    const kit = await alphaWithACard();
    await new SessionRecordStore(kit.files, { sessions: SESSIONS }).write('alpha', { claudePid: CLAUDE_PID, claudeSession: CLAUDE_SESSION, at: '2030-01-08T08:00:00.000Z' });
    const { options, processes } = hostOf([{ pid: CLAUDE_PID, parent: 8000, bytes: 1100 * MB }]);
    const result = ok(await kit.run(['meet', 'app-alpha'], options));
    assert.deepEqual(result.stdout, ['WOKE app-alpha (session alpha): 1 card(s) waiting on owner; an inbox line asks it to bring them now']);
    assert.deepEqual(processes.started, []);
    const asks = await new WakeAsks(kit.files, ASKS).read('alpha');
    assert.deepEqual(
      asks.map((stored) => [stored.ask?.from, stored.ask?.text]),
      [['owner', meetAsk('alpha', 'owner')]],
    );
    const inbox = ok(await kit.run(['inbox', 'read', '--session', 'alpha'])).stdout;
    assert.ok(inbox.some((line) => line.endsWith(`owner: ${meetAsk('alpha', 'owner')}`)), inbox.join('\n'));
  });

  it("refuses a session with no card due, and one it cannot tell runs, opening nothing", async () => {
    const kit = await alphaWithACard();
    const none = hostOf([]);
    assertRefused(await kit.run(['meet', 'bravo'], none.options), /^REFUSED app-bravo \(session bravo\) has no card waiting on owner now$/);
    const blind = hostOf([]);
    assertRefused(await kit.run(['meet', 'alpha'], { ...blind.options, memory: new FakeHostMemory().lists(undefined) }), /^REFUSED teamrig could not list the host's processes, so it cannot tell whether alpha runs$/);
    assert.deepEqual([...none.processes.started, ...blind.processes.started], []);
  });
});
