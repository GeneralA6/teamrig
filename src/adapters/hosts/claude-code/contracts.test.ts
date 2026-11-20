import { bind, TRANSCRIPT_CONTRACT, type TranscriptWorld } from '../../../conformance/index.ts';
import { describeContracts } from '../../../testing/contracts.ts';
import { promptLine, resultsLine } from '../../../testing/transcript-lines.ts';
import { declaration } from './declaration.ts';
import { transcriptReader } from './transcript.ts';

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

describeContracts({
  side: 'host',
  declaration,
  bound: [bind({ contract: TRANSCRIPT_CONTRACT, make: () => ({ port: transcriptReader, world: transcriptWorld }) })],
});
