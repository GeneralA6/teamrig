import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseObject } from '../core/jsonl.ts';
import { promptLine, replyLine, resultsLine, systemLine } from '../testing/transcript-lines.ts';
import { callOf, parseTranscriptLine } from './line.ts';

const AT = '2026-03-02T10:00:00.000Z';

function keyOf(raw: string): string | undefined {
  const entry = parseObject(raw);
  return entry === undefined ? 'unparsed' : callOf(entry)?.key;
}

describe('parseTranscriptLine', () => {
  it('reads a reply: its key, time, thread, usage and tool calls', () => {
    const raw = replyLine({
      id: 'msg_1',
      requestId: 'req_1',
      at: AT,
      usage: { input: 2, cacheRead: 100, output: 7 },
      tools: [
        { id: 't1', name: 'Bash', command: 'npm test' },
        { id: 't2', name: 'Read' },
      ],
    });
    assert.deepEqual(parseTranscriptLine(raw), {
      kind: 'call',
      key: 'msg_1|req_1',
      at: Date.parse(AT),
      mainThread: true,
      usage: { input: 2, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnsplit: 0, cacheRead: 100, output: 7 },
      tools: [
        { id: 't1', name: 'Bash', command: 'npm test' },
        { id: 't2', name: 'Read', command: undefined },
      ],
    });
  });

  it('keys a reply without a request id by its message id, and leaves one without a message id unkeyed', () => {
    assert.equal(keyOf(replyLine({ id: 'msg_2', usage: {} })), 'msg_2|');
    assert.equal(keyOf(replyLine({ usage: {} })), undefined);
  });

  it('marks a subagent reply, and one that does not say, as off the main thread', () => {
    const sidechain = parseTranscriptLine(replyLine({ id: 'm', at: AT, sidechain: true, usage: {} }));
    const unsaid = parseTranscriptLine(JSON.stringify({ type: 'assistant', message: { usage: {} } }));
    assert.equal(sidechain?.kind === 'call' && sidechain.mainThread, false);
    assert.equal(unsaid?.kind === 'call' && unsaid.mainThread, false);
  });

  it('leaves the time undefined when the timestamp is missing or unreadable', () => {
    assert.equal(parseTranscriptLine(replyLine({ id: 'm', usage: {} }))?.at, undefined);
    assert.equal(parseTranscriptLine(replyLine({ id: 'm', at: 'yesterday', usage: {} }))?.at, undefined);
  });

  it('skips tool blocks without an id or a name, and other blocks', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      message: {
        usage: {},
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', name: 'Bash' },
          { type: 'tool_use', id: 'x' },
          'loose',
          { type: 'tool_use', id: 'y', name: 'Grep', input: 'q' },
        ],
      },
    });
    const line = parseTranscriptLine(raw);
    assert.deepEqual(line?.kind === 'call' ? line.tools : undefined, [{ id: 'y', name: 'Grep', command: undefined }]);
  });

  it('reads tool results from a string or from text blocks, with their error mark', () => {
    const raw = JSON.stringify({
      type: 'user',
      timestamp: AT,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'plain', is_error: true },
          { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'one' }, { type: 'image' }, 'loose', { type: 'text', text: 'two' }] },
          { type: 'tool_result', tool_use_id: 'c' },
          { type: 'tool_result', content: 'no id' },
        ],
      },
    });
    assert.deepEqual(parseTranscriptLine(raw), {
      kind: 'results',
      at: Date.parse(AT),
      results: [
        { id: 'a', isError: true, text: 'plain' },
        { id: 'b', isError: false, text: 'one\n\ntwo' },
        { id: 'c', isError: false, text: '' },
      ],
    });
  });

  it('reads a user line without results as a prompt, and skips text Claude Code adds itself', () => {
    assert.deepEqual(parseTranscriptLine(promptLine(AT)), { kind: 'prompt', at: Date.parse(AT) });
    assert.equal(parseTranscriptLine(resultsLine(AT, [{ id: 'a', text: 'ok' }]))?.kind, 'results');
    assert.equal(parseTranscriptLine(JSON.stringify({ type: 'user', isMeta: true, message: { content: 'note' } })), undefined);
    assert.equal(parseTranscriptLine(JSON.stringify({ type: 'user', message: 'flat' })), undefined);
  });

  it('skips lines it does not count, damaged and torn lines, and replies without readable usage', () => {
    assert.equal(parseTranscriptLine(systemLine(AT)), undefined);
    assert.equal(parseTranscriptLine(replyLine({ id: 'm', at: AT, usage: { input: 1 } }).slice(0, -5)), undefined);
    assert.equal(parseTranscriptLine(JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: -1 } } })), undefined);
    assert.equal(parseTranscriptLine(JSON.stringify({ type: 'summary', usage: 1 })), undefined);
    assert.equal(parseTranscriptLine(JSON.stringify({ type: 'assistant', message: { content: [] } })), undefined);
    assert.equal(parseTranscriptLine('"usage"'), undefined);
  });
});
