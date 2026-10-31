import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseObject } from '../core/jsonl.ts';
import { blockStartLines } from '../hooks/live-tasks.ts';
import { compactLine, promptLine, replyLine, resultsLine, sessionStartNoteLine, systemLine } from '../testing/transcript-lines.ts';
import { callOf, parseTranscriptLine, tasksIn } from './line.ts';

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
    assert.deepEqual(parseTranscriptLine(promptLine(AT)), { kind: 'prompt', at: Date.parse(AT), trigger: 'other', commands: [] });
    assert.equal(parseTranscriptLine(resultsLine(AT, [{ id: 'a', text: 'ok' }]))?.kind, 'results');
    assert.equal(parseTranscriptLine(JSON.stringify({ type: 'user', isMeta: true, message: { content: 'note' } })), undefined);
    assert.equal(parseTranscriptLine(JSON.stringify({ type: 'user', message: 'flat' })), undefined);
  });

  it('names the skill a Skill call loads, and the slash commands a prompt runs', () => {
    const reply = JSON.stringify({
      isSidechain: false,
      type: 'assistant',
      timestamp: AT,
      message: {
        id: 'm',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: 'tool_use', id: 's', name: 'Skill', input: { skill: 'alpha-check', args: 'x' } },
          { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls', skill: 'not-a-load', run_in_background: true } },
          { type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'ls', run_in_background: 'yes' } },
        ],
      },
    });
    const call = parseTranscriptLine(reply);
    assert.deepEqual(call?.kind === 'call' ? call.tools.map((tool) => tool.skill) : undefined, ['alpha-check', undefined, undefined]);
    assert.deepEqual(call?.kind === 'call' ? call.tools.map((tool) => tool.background) : undefined, [undefined, true, undefined]);
    const prompt = parseTranscriptLine(promptLine(AT, '<command-message>x</command-message>\n<command-name>/alpha-check</command-name> <command-name>clear</command-name>'));
    assert.deepEqual(prompt?.kind === 'prompt' ? prompt.commands : undefined, ['alpha-check', 'clear']);
  });

  it('names the agent type an Agent call runs, general-purpose when it names none (T1232)', () => {
    const call = parseTranscriptLine(
      replyLine({
        id: 'm',
        usage: { input: 1, output: 1 },
        tools: [
          { id: 'a', name: 'Agent', agent: 'code-reader' },
          { id: 'g', name: 'Agent' },
          { id: 'b', name: 'Bash', command: 'ls', agent: 'not-a-start' },
        ],
      }),
    );
    assert.deepEqual(call?.kind === 'call' ? call.tools.map((tool) => tool.agent) : undefined, ['code-reader', 'general-purpose', undefined]);
  });

  it('keeps the address a WebFetch call reads, and the task ids a prompt names (T736)', () => {
    const reply = JSON.stringify({
      isSidechain: false,
      type: 'assistant',
      timestamp: AT,
      message: {
        id: 'm',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: 'tool_use', id: 'w', name: 'WebFetch', input: { url: 'https://vendor.example/terms', prompt: 'x' } },
          { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls', url: 'https://not.read/' } },
        ],
      },
    });
    const call = parseTranscriptLine(reply);
    assert.deepEqual(call?.kind === 'call' ? call.tools.map((tool) => tool.url) : undefined, ['https://vendor.example/terms', undefined]);
    const prompt = parseTranscriptLine(promptLine(AT, 'T12 and T7, then T12 again; not T0, T05 or AT5'));
    assert.deepEqual(prompt?.kind === 'prompt' ? prompt.tasks : undefined, ['T12', 'T7']);
    assert.equal(tasksIn('no task here').length, 0);
  });

  it('names the background call a task notification reports on, and none for a prompt that quotes one', () => {
    const tagged = '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n</task-notification>';
    const notice = JSON.stringify({ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: tagged }, timestamp: AT });
    const answers = (raw: string): string | undefined => {
      const line = parseTranscriptLine(raw);
      return line?.kind === 'prompt' ? line.answers : undefined;
    };
    assert.equal(answers(notice), 'toolu_1');
    assert.equal(answers(promptLine(AT, '<task-notification>done</task-notification>')), undefined);
    assert.equal(answers(promptLine(AT, 'see <tool-use-id>toolu_1</tool-use-id>')), undefined);
  });

  it('names what started a turn from the origin Claude Code writes, else from the text', () => {
    const user = (fields: Readonly<Record<string, unknown>>, content: unknown = 'go'): string =>
      JSON.stringify({ type: 'user', message: { role: 'user', content }, timestamp: AT, ...fields });
    const triggerOf = (raw: string): string | undefined => {
      const line = parseTranscriptLine(raw);
      return line?.kind === 'prompt' ? line.trigger : undefined;
    };
    const lines = [
      user({ origin: { kind: 'human' } }),
      user({ turnOrigin: 'human' }),
      user({ origin: { kind: 'peer', name: 'lead' } }),
      user({ origin: { kind: 'peer', handback: true } }),
      user({ origin: { kind: 'task-notification', producer: 'session-task' } }),
      user({}, '<task-notification>\n<task-id>a</task-id>'),
      user({}, [{ type: 'text', text: '<cross-session-message from="lead">hi' }]),
      user({ turnOrigin: 'peer' }),
      user({ turnOrigin: 'scheduled', origin: { kind: 'human' } }),
      user({ isSidechain: true, origin: { kind: 'human' } }),
      user({ isCompactSummary: true, origin: { kind: 'human' } }),
      user({}),
    ];
    assert.deepEqual(lines.map(triggerOf), [
      'owner',
      'owner',
      'peer',
      'notification',
      'notification',
      'notification',
      'peer',
      'peer',
      'scheduled',
      'subagent',
      'continuation',
      'other',
    ]);
  });

  it('reads a compaction marker', () => {
    assert.deepEqual(parseTranscriptLine(compactLine(AT)), { kind: 'compact', at: Date.parse(AT) });
  });

  it('reads a SessionStart note holding the start note line as a work-block start, and no other note or text (T1529)', () => {
    const start = blockStartLines('alpha', { at: 'Mon 03-02 12:00 IST', meetings: undefined, week: undefined }, 'teamrig').join('\n');
    assert.deepEqual(parseTranscriptLine(sessionStartNoteLine(AT, ['# Team rules', `${start}\nLIVE TASKS of alpha`])), { kind: 'start-note', at: Date.parse(AT) });
    assert.equal(parseTranscriptLine(sessionStartNoteLine(AT, ['# Team rules', 'LIVE TASKS of alpha'])), undefined, 'a note with no start line');
    assert.equal(parseTranscriptLine(sessionStartNoteLine(AT, [start], 'UserPromptSubmit')), undefined, 'another hook');
    assert.equal(parseTranscriptLine(sessionStartNoteLine(AT, [`quoted: ${start}`])), undefined, 'a line that only quotes it');
    assert.equal(parseTranscriptLine(promptLine(AT, start))?.kind, 'prompt', 'a prompt that quotes it');
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
