import type { On, SessionCompacted, SessionContextBreakdown, SessionMessage, ToolCallResult } from 'claude-code';
import { describe, expect, mock, test, type Engine } from 'claude-code/testing';

/**
 * The mod's refresh wiring (`register.ts`) against the engine itself: the test's hooks stand for the engine
 * beneath it, answering the plugin's CLI runs, the session's figures and the tool or compaction it wraps. The
 * hand's own rules are tested in src/mod/refresh-hand.test.ts.
 */

const TAB = '0123abcd-0000-4000-8000-0000000000a1';
const ASK = 'teamrig: your context is 130k (refresh at 120k), so refresh within this turn.';
const SKIP = 'teamrig: the handover is asked for and the fresh start follows this turn, so compaction waits until 185k (now 170k)';
const PONG: ToolCallResult = { result: 'pong', text: 'pong' };
/** The main conversation as a compaction reads it, and the summary the engine beneath compacts it to. */
const MESSAGES: readonly SessionMessage[] = [{ role: 'user', text: 'ship T521', toolUses: [] }];
const COMPACTED: SessionCompacted = { messages: [{ role: 'user', text: 'Summary: T521 shipped.', toolUses: [] }] };

/** What the tab's CLI answers each refresh command; a command left out exits 1. */
interface CliAnswers {
  readonly 'refresh-mid'?: unknown;
  readonly 'compact-check'?: unknown;
}

/** One run of the plugin's CLI: its command and what it read on stdin. */
interface CliRun {
  readonly command: string | undefined;
  readonly stdin: unknown;
}

/** Claude Code's estimate of the context against its compaction window, as /context breaks it down. */
function breakdownOf(totalTokens: number, rawMaxTokens: number): SessionContextBreakdown {
  return {
    categories: [],
    totalTokens,
    maxTokens: rawMaxTokens,
    rawMaxTokens,
    autocompactSource: 'model-default',
    percentage: Math.round((totalTokens / rawMaxTokens) * 100),
    gridRows: [],
    model: 'claude-test',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
  };
}

/**
 * An interactive tab whose last reply read 130k, and whose compaction estimate is 170k of a 200k window: starts
 * the session, which builds the hands, and records each run of the plugin's CLI.
 */
async function tab($: Engine, on: On, answers: CliAnswers, tool: ToolCallResult = PONG): Promise<CliRun[]> {
  const runs: CliRun[] = [];
  mock.clock(on, { now: 1_000_000 });
  on('session.id', () => ({ value: TAB }));
  on('session.cwd', () => ({ value: '/work/app/src' }));
  on('session.root', () => ({ value: '/work/app' }));
  on('ui.log', () => ({ value: undefined }));
  on('session.usage', (_$, e) => ({
    value: {
      startedAt: 0,
      context: { tokens: 130_000, window: 200_000, ...(e.breakdown === undefined ? {} : { breakdown: breakdownOf(170_000, 200_000) }) },
      rateLimits: [],
    },
  }));
  on('process.run', (_$, e) => {
    const command = e.argv.at(-1);
    runs.push({ command, stdin: JSON.parse(e.init?.stdin ?? 'null') });
    const answer = command === 'refresh-mid' || command === 'compact-check' ? answers[command] : undefined;
    return {
      value: {
        exitCode: answer === undefined ? 1 : 0,
        stdout: answer === undefined ? '' : `${JSON.stringify(answer)}\n`,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  on('tool.call', () => tool);
  on('session.compact', () => COMPACTED);
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true });
  return runs;
}

describe('the refresh within a turn', () => {
  test("adds the CLI's ask after a tool result of the main conversation, as the tab's session", async ($, on) => {
    const runs = await tab($, on, { 'refresh-mid': { kind: 'ask', text: ASK, nextAt: 154_000 } });
    const result = await $.tool.call({ tool: 'mcp__demo__ping', tool_use_id: 'toolu_1' });
    expect(result.context).toEqual([ASK]);
    expect(runs).toEqual([{ command: 'refresh-mid', stdin: { session_id: TAB, cwd: '/work/app/src', tokens: 130_000 } }]);
  });

  test('asks nothing after a subagent tool, a denied call or a quiet answer', async ($, on) => {
    const runs = await tab($, on, { 'refresh-mid': { kind: 'wait', nextAt: 140_000 } });
    expect((await $.tool.call({ tool: 'mcp__demo__ping', tool_use_id: 'toolu_1', agentId: 'agent-1' })).context).toBeUndefined();
    expect(runs).toEqual([]);
    expect((await $.tool.call({ tool: 'mcp__demo__ping', tool_use_id: 'toolu_2' })).context).toBeUndefined();
    expect(runs.length).toBe(1);
  });

  test('passes a denied call on as it is, with no ask', async ($, on) => {
    const runs = await tab($, on, { 'refresh-mid': { kind: 'ask', text: ASK, nextAt: 154_000 } }, { deny: 'not here' });
    expect(await $.tool.call({ tool: 'mcp__demo__ping', tool_use_id: 'toolu_1' })).toEqual({ deny: 'not here' });
    expect(runs).toEqual([]);
  });
});

describe('the compaction while a refresh is due', () => {
  test("skips Claude Code's own compaction of the main conversation while the CLI says so, on the figures it compacts on", async ($, on) => {
    const runs = await tab($, on, { 'compact-check': { kind: 'skip', reason: SKIP } });
    expect(await $.session.compact({ trigger: 'auto', messages: MESSAGES })).toEqual({ skip: SKIP });
    expect(await $.session.compact({ trigger: 'precompute', messages: MESSAGES })).toEqual({ skip: SKIP });
    expect(runs[0]).toEqual({ command: 'compact-check', stdin: { session_id: TAB, cwd: '/work/app/src', tokens: 170_000, window: 200_000 } });
  });

  test("lets the person's, a plugin's and a subagent's compaction go, and any the CLI cannot answer", async ($, on) => {
    const runs = await tab($, on, {});
    expect(await $.session.compact({ trigger: 'manual', messages: MESSAGES })).toEqual(COMPACTED);
    expect(await $.session.compact({ trigger: 'plugin', messages: MESSAGES })).toEqual(COMPACTED);
    expect(await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages: MESSAGES })).toEqual(COMPACTED);
    expect(runs).toEqual([]);
    expect(await $.session.compact({ trigger: 'auto', messages: MESSAGES })).toEqual(COMPACTED);
    expect(runs.length).toBe(1);
  });
});
