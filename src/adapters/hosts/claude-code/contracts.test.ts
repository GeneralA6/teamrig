import { bind, TRANSCRIPT_CONTRACT, USAGE_CONTRACT, type TranscriptWorld, type UsageWorld } from '../../../conformance/index.ts';
import type { RateWindow } from '../../../plugin-api/index.ts';
import { describeContracts } from '../../../testing/contracts.ts';
import { promptLine, resultsLine } from '../../../testing/transcript-lines.ts';
import { declaration } from './declaration.ts';
import { transcriptReader } from './transcript.ts';
import { usageMeter } from './usage.ts';

const AT = '2026-01-05T10:00:00.000Z';

/** The lines Claude Code writes for what a transcript case names. */
const transcriptWorld: TranscriptWorld = {
  prompt: (text, thread) => promptLine(AT, text, thread === 'helper'),
  reply: ({ text, call }) =>
    JSON.stringify({
      isSidechain: false,
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', id: call.id, name: call.name, input: {} }] },
      timestamp: AT,
    }),
  result: (call, text, failed) => resultsLine(AT, [{ id: call, text, isError: failed }]),
  title: (text) => JSON.stringify({ type: 'custom-title', customTitle: text, sessionId: 'session-1' }),
  unknown: () => JSON.stringify({ type: 'file-history-snapshot', messageId: 'message-1', snapshot: {} }),
  torn: () => promptLine(AT, 'a prompt the write never finished').slice(0, 40),
};

/** A window as Claude Code's status input holds it, its reset in epoch seconds. */
function statusWindow(window: RateWindow | undefined): { used_percentage: number; resets_at: number } | undefined {
  return window === undefined ? undefined : { used_percentage: window.usedPct, resets_at: window.resetsAt / 1000 };
}

/** The status input Claude Code hands its status line: `rate_limits` only when the plan tells a window. */
const usageWorld: UsageWorld = {
  status: ({ week, fiveHour }) =>
    JSON.stringify({
      session_id: 'session-1',
      model: { display_name: 'Model' },
      ...(week === undefined && fiveHour === undefined ? {} : { rate_limits: { five_hour: statusWindow(fiveHour), seven_day: statusWindow(week) } }),
    }),
};

describeContracts({
  side: 'host',
  declaration,
  bound: [
    bind({ contract: TRANSCRIPT_CONTRACT, make: () => ({ port: transcriptReader, world: transcriptWorld }) }),
    bind({ contract: USAGE_CONTRACT, make: () => ({ port: usageMeter, world: usageWorld }) }),
  ],
});
