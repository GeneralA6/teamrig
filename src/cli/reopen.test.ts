import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { projectTranscriptPath } from '../budget/discover.ts';
import type { CommitCharge } from '../coordinator/memory.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { decodePrompt, defaultPrompt, reopenPrompt } from '../open/prompt.ts';
import { SessionLog, type CloseRecord } from '../sessions/log.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, USER_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakePathProbe, FakeProcesses } from '../testing/fake-processes.ts';
import { ok } from '../testing/hired-team.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { EXIT } from './runtime.ts';

const HOUR_MS = 3_600_000;
const LOG = join(TEAM_HOME, 'state', 'session-log.jsonl');
const TRANSCRIPT = projectTranscriptPath(join(USER_HOME, '.claude', 'projects'), APP, CLAUDE_SESSION);
/** Alpha, closed by the lead after 75 quiet minutes in Claude Code session CLAUDE_SESSION. */
const CLOSED: CloseRecord = { kind: 'close', session: 'alpha', by: 'lead', at: '2030-01-08T08:00:00.000Z', claudeSession: CLAUDE_SESSION, idleMinutes: 75, freedMb: 1300 };

/** A transcript line the way Claude Code writes an assistant reply, with `tokens` of context. */
function reply(tokens: number): string {
  return `${JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', usage: { input_tokens: 2, cache_read_input_tokens: tokens - 2, output_tokens: 50 } } })}\n`;
}

interface ClosedAlpha {
  readonly kit: CliHarness;
  readonly options: RunOptions;
}

/** A team (`config`) whose alpha the lead closed, its last transcript holding `tokens` of context, last written 2 h ago. */
async function closedAlpha(tokens: number, config: JsonRecord = TEAM): Promise<ClosedAlpha> {
  const kit = new CliHarness(config);
  await new SessionLog(kit.files, LOG).append(CLOSED);
  await kit.files.write(TRANSCRIPT, reply(tokens));
  const transcripts = new MemoryTranscripts({ [TRANSCRIPT]: reply(tokens) }, kit.clock.now() - 2 * HOUR_MS);
  return { kit, options: { platform: 'win32', probe: new FakePathProbe({ folders: [APP] }), transcripts } };
}

/** Opens alpha in a Windows Terminal tab; returns the run and what the tab runs. */
async function open(alpha: ClosedAlpha, extra: readonly string[] = []): Promise<{ result: CliResult; argv: readonly string[] }> {
  const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started' });
  const result = await alpha.kit.run(['open', 'alpha', ...extra], { ...alpha.options, processes });
  return { result, argv: processes.started[0]?.args ?? [] };
}

/** The first prompt a tab's launch line carries. */
function promptOf(argv: readonly string[]): string | undefined {
  const encoded = argv[argv.indexOf('--encoded-prompt') + 1];
  return encoded === undefined ? undefined : decodePrompt(encoded);
}

/** The Claude Code session a tab's launch line resumes, if any. */
function resumedOf(argv: readonly string[]): string | undefined {
  const at = argv.indexOf('--resume');
  return at < 0 ? undefined : argv[at + 1];
}

async function logOf(alpha: ClosedAlpha): Promise<unknown> {
  return (await new SessionLog(alpha.kit.files, LOG).read()).records;
}

describe('opening a session teamrig closed', () => {
  it('resumes its last Claude Code session, logs the reopen, and then opens it as any session', async () => {
    const alpha = await closedAlpha(40_000);
    const { result, argv } = await open(alpha);
    assert.ok(ok(result).stdout[0]?.endsWith(`, resuming Claude Code session ${CLAUDE_SESSION}`), result.stdout[0]);
    assert.equal(resumedOf(argv), CLAUDE_SESSION);
    assert.equal(promptOf(argv), reopenPrompt('app', 'alpha'));
    const at = new Date(alpha.kit.clock.now()).toISOString();
    assert.deepEqual(await logOf(alpha), [CLOSED, { kind: 'reopen', session: 'alpha', at, resumed: CLAUDE_SESSION }]);

    const again = await open(alpha);
    assert.equal(resumedOf(again.argv), undefined, 'once reopened, it opens as any session');
    assert.equal(promptOf(again.argv), defaultPrompt('app', 'alpha'));
    assert.equal((await new SessionLog(alpha.kit.files, LOG).read()).records.length, 2);
  });

  it('opens fresh, with why, when its last session is too big, and --resume then refuses', async () => {
    const alpha = await closedAlpha(400_000);
    const refused = await open(alpha, ['--resume']);
    assert.equal(refused.result.code, EXIT.refused);
    assert.match(refused.result.stdout.join('\n'), /^REFUSED not resumed: its last Claude Code session \S+ holds 400000 tokens of context, idle 0\.1 day\(s\): over hiring\.resumeMaxTokens 250000; teamrig open alpha opens it fresh$/);
    assert.deepEqual(refused.argv, [], 'a refusal opens no tab');
    assert.deepEqual(await logOf(alpha), [CLOSED]);

    const { result, argv } = await open(alpha);
    assert.ok(ok(result).stdout[0]?.endsWith(', fresh (its last Claude Code session ' + CLAUDE_SESSION + ' holds 400000 tokens of context, idle 0.1 day(s): over hiring.resumeMaxTokens 250000)'), result.stdout[0]);
    assert.equal(resumedOf(argv), undefined);
    assert.equal(promptOf(argv), defaultPrompt('app', 'alpha'));
    assert.deepEqual(await logOf(alpha), [CLOSED, { kind: 'reopen', session: 'alpha', at: new Date(alpha.kit.clock.now()).toISOString() }]);
  });

  it('logs no reopen when no terminal opens', async () => {
    const alpha = await closedAlpha(40_000);
    const result = await alpha.kit.run(['open', 'alpha', '--terminal', 'print'], alpha.options);
    assert.equal(result.code, EXIT.printed, result.stdout.join('\n'));
    assert.deepEqual(await logOf(alpha), [CLOSED]);
  });
});

const PASS_LOG = join(TEAM_HOME, 'state', 'idle-pass.jsonl');
const CHARGE: CommitCharge = { usedMb: 40_000, limitMb: 100_700 };

/** Hands alpha a p1 task, which wakes it. */
async function handWork(alpha: ClosedAlpha): Promise<void> {
  const added = await alpha.kit.run(['add', '--title', 'Fix the outage', '--description', 'what and why', '--priority', 'p1', '--owner', 'alpha', '--session', 'lead']);
  assert.equal(added.code, 0, added.stderr.join('\n'));
}

/** Runs the idle pass's reopen of alpha on a host whose memory is `memory`. */
async function idleOpen(alpha: ClosedAlpha, memory = new FakeHostMemory().lists([], CHARGE)): Promise<{ result: CliResult; argv: readonly string[] }> {
  const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started' });
  const result = await alpha.kit.run(['idle-open', 'alpha', '--team', 'app', '--project', APP], { ...alpha.options, processes, memory });
  return { result, argv: processes.started[0]?.args ?? [] };
}

/** The pass log's act lines, without their time. */
function actsOf(alpha: ClosedAlpha): JsonRecord[] {
  return (alpha.kit.files.get(PASS_LOG) ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      assert.ok(isRecord(parsed), line);
      return Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'at'));
    });
}

describe('teamrig idle-open', () => {
  it('reopens a closed session work would wake as teamrig open does, and logs the act with the commit charge before', async () => {
    const alpha = await closedAlpha(40_000);
    await handWork(alpha);
    const { result, argv } = await idleOpen(alpha);
    assert.equal(result.code, 0, [...result.stdout, ...result.stderr].join('\n'));
    const [line = ''] = result.stdout;
    assert.match(line, /^REOPENED app-alpha \(session alpha\) for work handed to it since its close: T1: OPENED app-alpha \(session alpha\) in a new Windows Terminal tab in /);
    assert.ok(line.endsWith(`, resuming Claude Code session ${CLAUDE_SESSION}`), line);
    assert.equal(resumedOf(argv), CLAUDE_SESSION);
    assert.equal(promptOf(argv), reopenPrompt('app', 'alpha'));
    assert.deepEqual(await logOf(alpha), [CLOSED, { kind: 'reopen', session: 'alpha', at: new Date(alpha.kit.clock.now()).toISOString(), resumed: CLAUDE_SESSION }]);
    assert.deepEqual(actsOf(alpha), [{ v: 1, kind: 'act', mode: 'off', act: 'reopen', id: 'alpha', outcome: 'done', line, before: CHARGE }]);
  });

  it('keeps closed a session with nothing it can start, and opens nothing for one teamrig no longer holds closed', async () => {
    const idle = await closedAlpha(40_000);
    const kept = await idleOpen(idle);
    assert.equal(kept.result.code, 0, kept.result.stderr.join('\n'));
    assert.deepEqual(kept.result.stdout, ['KEPT app-alpha (session alpha): still closed, nothing it can start']);
    assert.deepEqual(kept.argv, []);
    assert.deepEqual(await logOf(idle), [CLOSED]);
    assert.deepEqual(actsOf(idle), [{ v: 1, kind: 'act', mode: 'off', act: 'reopen', id: 'alpha', outcome: 'kept', line: kept.result.stdout[0] }]);

    const reopened = await closedAlpha(40_000);
    await handWork(reopened);
    await new SessionLog(reopened.kit.files, LOG).append({ kind: 'reopen', session: 'alpha', at: '2030-01-08T09:00:00.000Z' });
    const away = await idleOpen(reopened);
    assert.deepEqual(away.result.stdout, ['KEPT app-alpha (session alpha): not running, and teamrig did not close it']);
    assert.deepEqual(away.argv, []);
  });

  it('keeps it closed when the host has no room, and fails, logged, when it cannot weigh it or no terminal opens', async () => {
    const crowded = await closedAlpha(40_000);
    await handWork(crowded);
    const full = { usedMb: 99_000, limitMb: 100_000 };
    const noRoom = await idleOpen(crowded, new FakeHostMemory().lists([], full));
    assert.equal(noRoom.result.code, 0, noRoom.result.stderr.join('\n'));
    assert.match(noRoom.result.stdout.join('\n'), /^KEPT app-alpha \(session alpha\) closed: no room on the host to open app-alpha \(session alpha\), counted at /);
    assert.deepEqual(noRoom.argv, []);
    assert.deepEqual(await logOf(crowded), [CLOSED]);
    assert.deepEqual(actsOf(crowded), [{ v: 1, kind: 'act', mode: 'off', act: 'reopen', id: 'alpha', outcome: 'kept', line: noRoom.result.stdout[0], before: full }]);

    const blind = await closedAlpha(40_000);
    const unweighed = await idleOpen(blind, new FakeHostMemory().lists(undefined));
    assert.equal(unweighed.result.code, EXIT.failed);
    assert.deepEqual(unweighed.result.stdout, ["FAILED to weigh app-alpha (session alpha): teamrig could not list the host's processes, so it cannot tell which sessions run"]);

    const printing = await closedAlpha(40_000, { ...TEAM, open: { terminal: 'print' } });
    await handWork(printing);
    const manual = await idleOpen(printing);
    assert.equal(manual.result.code, EXIT.failed);
    assert.deepEqual(manual.result.stdout, ['FAILED to reopen app-alpha (session alpha): no terminal opened (the terminal setting is print)']);
    assert.deepEqual(await logOf(printing), [CLOSED]);
    assert.equal(actsOf(printing)[0]?.['outcome'], 'failed');
  });
});
