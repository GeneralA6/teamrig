import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { projectTranscriptPath } from '../budget/discover.ts';
import { decodePrompt, defaultPrompt, reopenPrompt } from '../open/prompt.ts';
import { SessionLog, type CloseRecord } from '../sessions/log.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, USER_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
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

/** A team whose alpha the lead closed, its last transcript holding `tokens` of context, last written 2 h ago. */
async function closedAlpha(tokens: number): Promise<ClosedAlpha> {
  const kit = new CliHarness(TEAM);
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
