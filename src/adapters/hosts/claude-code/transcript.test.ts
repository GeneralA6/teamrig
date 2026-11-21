import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { FolderNames } from '../../../testing/folder-names.ts';
import { loadRecording } from '../../../testing/recorded.ts';
import { apiErrorLine, compactLine, promptLine, replyLine, resultsLine, sessionStartNoteLine, summaryLine, systemLine, textLine } from '../../../testing/transcript-lines.ts';
import { transcriptReader } from './transcript.ts';

const AT = '2026-01-05T10:00:00.000Z';
const AT_MS = Date.parse(AT);

/** What an entry holds when its line names no id, time, session or thread, nor where it ran. */
const BARE = { at: undefined, id: undefined, parent: undefined, session: undefined, thread: undefined, meta: false, job: undefined } as const;
/** What an input holds beyond its content. */
const PLAIN_INPUT = { kind: 'input', text: undefined, parts: [], results: [], origin: undefined, turnOrigin: undefined, continuation: false, fromTool: false, background: undefined } as const;
/** What a reply holds beyond its content. */
const PLAIN_REPLY = { kind: 'reply', key: undefined, model: undefined, effort: undefined, usage: undefined, texts: [], calls: [], synthetic: false, failed: false, error: undefined } as const;

function userLine(extra: Readonly<Record<string, unknown>>, content: unknown = 'go'): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });
}

function assistantLine(message: Readonly<Record<string, unknown>>, extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', ...message }, ...extra });
}

/** Where a line ran, as its entry says; a line that reads as no entry fails the spec. */
function jobOf(line: string): boolean | undefined {
  const entry = transcriptReader.entry(line);
  if (entry === undefined || entry.kind === 'unread') {
    return assert.fail(`no entry for ${line}`);
  }
  return entry.job;
}

describe("Claude Code's transcript lines as entries", () => {
  it('reads a typed prompt with its ids, its time, its session and its thread', () => {
    const line = userLine({ parentUuid: 'p-1', isSidechain: false, uuid: 'u-1', timestamp: AT, sessionId: 's-1', origin: { kind: 'human' }, turnOrigin: 'human' });
    assert.deepEqual(transcriptReader.entry(line), {
      ...PLAIN_INPUT,
      at: AT_MS,
      id: 'u-1',
      parent: 'p-1',
      session: 's-1',
      thread: 'main',
      meta: false,
      job: undefined,
      text: 'go',
      origin: 'person',
      turnOrigin: 'person',
    });
  });

  it('keeps the three states of the thread mark apart, and an unreadable time is none', () => {
    assert.deepEqual(transcriptReader.entry(promptLine(AT, 'go', true)), { ...BARE, ...PLAIN_INPUT, at: AT_MS, thread: 'helper', text: 'go' });
    assert.deepEqual(transcriptReader.entry(userLine({ timestamp: 'soon', parentUuid: null })), { ...BARE, ...PLAIN_INPUT, text: 'go' });
  });

  it("marks Claude Code's own text and a compaction's summary", () => {
    assert.deepEqual(transcriptReader.entry(userLine({ isMeta: true })), { ...BARE, ...PLAIN_INPUT, meta: true, text: 'go' });
    assert.deepEqual(transcriptReader.entry(summaryLine(AT)), { ...BARE, ...PLAIN_INPUT, at: AT_MS, thread: 'main', text: 'This session is being continued.', continuation: true });
  });

  it('reads a listed content as its text parts and its tool results, in order', () => {
    const content = [
      { type: 'text', text: 'one' },
      { type: 'image', source: { type: 'base64', data: 'AAAA' } },
      { type: 'tool_result', tool_use_id: 'call-1', content: 'done', is_error: false },
      { type: 'tool_result', tool_use_id: 'call-2', content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }], is_error: true },
      { type: 'tool_result', content: 7 },
      'stray',
      { type: 'text', text: 'two' },
      { type: 'text' },
    ];
    assert.deepEqual(transcriptReader.entry(userLine({}, content)), {
      ...BARE,
      ...PLAIN_INPUT,
      parts: ['one', 'two'],
      results: [
        { call: 'call-1', isError: false, text: 'done', data: undefined },
        { call: 'call-2', isError: true, text: 'a\n\nb', data: undefined },
        { call: undefined, isError: false, text: '', data: undefined },
      ],
    });
    assert.deepEqual(transcriptReader.entry(resultsLine(AT, [{ id: 'call-3', text: 'out', isError: true }])), {
      ...BARE,
      ...PLAIN_INPUT,
      at: AT_MS,
      thread: 'main',
      results: [{ call: 'call-3', isError: true, text: 'out', data: undefined }],
    });
  });

  it('gives a tool result the structured answer its line keeps, and none for an answer kept as text', () => {
    const content = [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }];
    const answer = { id: 'j-1', humanSchedule: 'every day', recurring: true };
    assert.deepEqual(transcriptReader.entry(userLine({ toolUseResult: answer }, content)), {
      ...BARE,
      ...PLAIN_INPUT,
      fromTool: true,
      results: [{ call: 'call-1', isError: false, text: 'ok', data: answer }],
    });
    for (const toolUseResult of ['Error: no such job', ['a'], null]) {
      assert.deepEqual(
        transcriptReader.entry(userLine({ toolUseResult }, content)),
        { ...BARE, ...PLAIN_INPUT, fromTool: true, results: [{ call: 'call-1', isError: false, text: 'ok', data: undefined }] },
        JSON.stringify(toolUseResult),
      );
    }
  });

  it('names the origin mark, a handback apart from a peer, and any mark it has no name for as unknown', () => {
    const origins: readonly (readonly [unknown, string | undefined])[] = [
      [{ kind: 'human' }, 'person'],
      [{ kind: 'peer' }, 'peer'],
      [{ kind: 'peer', handback: true }, 'handback'],
      [{ kind: 'human', handback: true }, 'person'],
      [{ kind: 'task-notification' }, 'notification'],
      [{ kind: 'task_notification' }, 'notification'],
      [{ kind: 'scheduled' }, 'scheduled'],
      [{ kind: 'plugin' }, 'unknown'],
      [{ kind: 'constructor' }, 'unknown'],
      [{}, 'unknown'],
      ['human', 'unknown'],
      [null, 'unknown'],
      [undefined, undefined],
    ];
    for (const [origin, expected] of origins) {
      assert.deepEqual(transcriptReader.entry(userLine({ origin })), { ...BARE, ...PLAIN_INPUT, text: 'go', origin: expected }, JSON.stringify(origin));
    }
  });

  it('names the turn origin by the same names, in either spelling of a notification', () => {
    const origins: readonly (readonly [unknown, string | undefined])[] = [
      ['human', 'person'],
      ['peer', 'peer'],
      ['task_notification', 'notification'],
      ['task-notification', 'notification'],
      ['scheduled', 'scheduled'],
      ['system', 'unknown'],
      ['toString', 'unknown'],
      [7, undefined],
      [undefined, undefined],
    ];
    for (const [turnOrigin, expected] of origins) {
      assert.deepEqual(transcriptReader.entry(userLine({ turnOrigin })), { ...BARE, ...PLAIN_INPUT, text: 'go', turnOrigin: expected }, JSON.stringify(turnOrigin));
    }
  });

  it('keeps the two origin marks apart when they differ', () => {
    assert.deepEqual(transcriptReader.entry(userLine({ origin: { kind: 'plugin' }, turnOrigin: 'system' })), { ...BARE, ...PLAIN_INPUT, text: 'go', origin: 'unknown', turnOrigin: 'unknown' });
    assert.deepEqual(transcriptReader.entry(userLine({ origin: { kind: 'task-notification' } })), { ...BARE, ...PLAIN_INPUT, text: 'go', origin: 'notification' });
  });

  it("reads what a tool's run left in the background or stopped", () => {
    const marks: readonly (readonly [unknown, unknown])[] = [
      [{ backgroundTaskId: 'b-1', stdout: '' }, { started: 'command', task: 'b-1', stopped: undefined }],
      [{ status: 'async_launched', agentId: 'a-1' }, { started: 'helper', task: 'a-1', stopped: undefined }],
      [{ taskId: 't-1' }, { started: 'task', task: 't-1', stopped: undefined }],
      [{ backgroundTaskId: 'b-2', status: 'async_launched', agentId: 'a-2', taskId: 't-2' }, { started: 'command', task: 'b-2', stopped: undefined }],
      [{ agentId: 'a-3', status: 'completed' }, { started: undefined, task: 'a-3', stopped: undefined }],
      [{ task_id: 't-9', message: 'stopped' }, { started: undefined, task: undefined, stopped: 't-9' }],
      [{ stdout: 'ok', backgroundTaskId: 7 }, undefined],
      ['Error: no such file', undefined],
      [['a'], undefined],
    ];
    for (const [toolUseResult, background] of marks) {
      assert.deepEqual(transcriptReader.entry(userLine({ toolUseResult })), { ...BARE, ...PLAIN_INPUT, text: 'go', fromTool: true, background }, JSON.stringify(toolUseResult));
    }
    assert.deepEqual(transcriptReader.entry(userLine({})), { ...BARE, ...PLAIN_INPUT, text: 'go' });
  });

  it('reads a reply with its join key, its model, its counts and its tool calls', () => {
    const line = replyLine({
      id: 'm-1',
      requestId: 'r-1',
      at: AT,
      model: 'model-x',
      usage: { input: 10, cacheWrite: 70, cacheWrite5m: 20, cacheWrite1h: 30, cacheRead: 40, output: 50 },
      tools: [{ id: 'call-1', name: 'Bash', command: 'ls' }],
    });
    assert.deepEqual(transcriptReader.entry(line), {
      ...BARE,
      ...PLAIN_REPLY,
      at: AT_MS,
      thread: 'main',
      key: 'm-1|r-1',
      model: 'model-x',
      usage: { input: 10, cacheWrite5m: 20, cacheWrite1h: 30, cacheWriteUnsplit: 20, cacheRead: 40, output: 50 },
      calls: [{ id: 'call-1', name: 'Bash', input: { command: 'ls' } }],
    });
  });

  it('reads the effort, the text parts, and only the calls that have an id and a name', () => {
    const content = [
      { type: 'thinking', thinking: 'hm', text: 'not a text part' },
      { type: 'text', text: 'first' },
      { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_use', id: 'call-2', name: 'Bash', input: 'ls' },
      { type: 'tool_use', name: 'Bash', input: {} },
      { type: 'tool_use', id: 'call-4', input: {} },
      { type: 'text', id: 'call-5', name: 'Bash', text: 'second' },
    ];
    assert.deepEqual(transcriptReader.entry(assistantLine({ id: 'm-2', content }, { effort: 'high', isSidechain: true })), {
      ...BARE,
      ...PLAIN_REPLY,
      thread: 'helper',
      key: 'm-2|',
      effort: 'high',
      texts: ['first', 'second'],
      calls: [
        { id: 'call-1', name: 'Read', input: { file_path: 'a.ts' } },
        { id: 'call-2', name: 'Bash', input: undefined },
      ],
    });
    assert.deepEqual(transcriptReader.entry(textLine('u-7', ['hello'], ['call-9'])), {
      ...BARE,
      ...PLAIN_REPLY,
      id: 'u-7',
      thread: 'main',
      texts: ['hello'],
      calls: [{ id: 'call-9', name: 'Bash', input: {} }],
    });
  });

  it('reads a missing count as 0, and the cache writes a split leaves out as unsplit', () => {
    assert.deepEqual(transcriptReader.entry(assistantLine({ usage: {} })), { ...BARE, ...PLAIN_REPLY, usage: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnsplit: 0, cacheRead: 0, output: 0 } });
    assert.deepEqual(transcriptReader.entry(assistantLine({ usage: { cache_creation_input_tokens: 9, output_tokens: 2, input_tokens: null } })), {
      ...BARE,
      ...PLAIN_REPLY,
      usage: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnsplit: 9, cacheRead: 0, output: 2 },
    });
    assert.deepEqual(transcriptReader.entry(assistantLine({ usage: { cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 3 } } })), {
      ...BARE,
      ...PLAIN_REPLY,
      usage: { input: 0, cacheWrite5m: 4, cacheWrite1h: 3, cacheWriteUnsplit: 0, cacheRead: 0, output: 0 },
    });
  });

  it('says a damaged usage is unreadable, never 0, and a reply without one carries none', () => {
    const damaged: readonly unknown[] = [
      { input_tokens: -1 },
      { output_tokens: 1.5 },
      { cache_read_input_tokens: '3' },
      { cache_creation: { ephemeral_5m_input_tokens: -2 } },
      { cache_creation: { ephemeral_1h_input_tokens: true } },
      'none',
      7,
      null,
      [],
    ];
    for (const usage of damaged) {
      assert.deepEqual(transcriptReader.entry(assistantLine({ usage })), { ...BARE, ...PLAIN_REPLY, usage: 'unreadable' }, JSON.stringify(usage));
    }
    assert.deepEqual(transcriptReader.entry(assistantLine({})), { ...BARE, ...PLAIN_REPLY });
  });

  it('marks the reply Claude Code wrote for a failed API call, with the error it names', () => {
    assert.deepEqual(transcriptReader.entry(apiErrorLine(AT, 's-1')), {
      ...PLAIN_REPLY,
      at: AT_MS,
      id: '00000000-0000-4000-8000-0000000000e2',
      parent: '00000000-0000-4000-8000-0000000000e1',
      session: 's-1',
      thread: 'main',
      meta: false,
      job: false,
      key: '00000000-0000-4000-8000-0000000000e3|',
      model: '<synthetic>',
      usage: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnsplit: 0, cacheRead: 0, output: 0 },
      texts: ['Login expired · Please run /login'],
      synthetic: true,
      failed: true,
      error: 'authentication_failed',
    });
    assert.deepEqual(transcriptReader.entry(assistantLine({}, { error: 'overloaded' })), { ...BARE, ...PLAIN_REPLY, error: 'overloaded' });
  });

  it('reads a compaction boundary', () => {
    assert.deepEqual(transcriptReader.entry(compactLine(AT)), { ...BARE, at: AT_MS, kind: 'compact' });
  });

  it("reads each of the three marks of a turn's end, and no other system line, as the end of a turn", () => {
    for (const subtype of ['stop_hook_summary', 'turn_duration', 'local_command']) {
      assert.deepEqual(transcriptReader.entry(JSON.stringify({ type: 'system', subtype })), { ...BARE, kind: 'turn-end' }, subtype);
    }
    assert.deepEqual(transcriptReader.entry(systemLine(AT)), { ...BARE, at: AT_MS, kind: 'turn-end' });
    assert.equal(transcriptReader.entry(JSON.stringify({ type: 'attachment', subtype: 'turn_duration' }))?.kind, 'other');
    assert.equal(transcriptReader.entry(JSON.stringify({ subtype: 'turn_duration' }))?.kind, 'other');
  });

  it('says where a line ran by its entrypoint: a background job, a tab, or nothing for a line with none', () => {
    assert.equal(jobOf(userLine({ entrypoint: 'cli', sessionKind: 'bg' })), true);
    assert.equal(jobOf(userLine({ entrypoint: 'cli' })), false);
    assert.equal(jobOf(assistantLine({ model: 'model-x' }, { entrypoint: 'sdk-cli', sessionKind: 'interactive' })), false);
    // The kind alone names no turn: only a line stamped with where it ran says it.
    assert.equal(jobOf(userLine({ sessionKind: 'bg' })), undefined);
    assert.equal(jobOf(JSON.stringify({ type: 'system', subtype: 'turn_duration', entrypoint: 'cli', sessionKind: 'bg' })), true);
  });

  it('reads the mark that a session carries on in another, with the session it names', () => {
    const line = JSON.stringify({ type: 'continued-in', timestamp: AT, sessionId: 's-1', continuedInSessionId: 's-2' });
    assert.deepEqual(transcriptReader.entry(line), { ...BARE, at: AT_MS, session: 's-1', kind: 'continued', into: 's-2' });
    assert.deepEqual(transcriptReader.entry(JSON.stringify({ type: 'continued-in' })), { ...BARE, kind: 'continued', into: undefined });
    assert.deepEqual(transcriptReader.entry(JSON.stringify({ type: 'continued-in', continuedInSessionId: 7 })), { ...BARE, kind: 'continued', into: undefined });
    // A prompt that only mentions the mark stays an input.
    assert.equal(transcriptReader.entry(userLine({}, 'the "type":"continued-in" record'))?.kind, 'input');
  });

  it("reads a hook's note with its texts, and whether it was written at the session's start", () => {
    assert.deepEqual(transcriptReader.entry(sessionStartNoteLine(AT, ['one', 'two'])), { ...BARE, at: AT_MS, thread: 'main', kind: 'hook-note', atStart: true, texts: ['one', 'two'] });
    assert.deepEqual(transcriptReader.entry(sessionStartNoteLine(AT, ['later'], 'UserPromptSubmit')), { ...BARE, at: AT_MS, thread: 'main', kind: 'hook-note', atStart: false, texts: ['later'] });
    const mixed = JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['kept', 7, null, { text: 'dropped' }], hookEvent: 'SessionStart' } });
    assert.deepEqual(transcriptReader.entry(mixed), { ...BARE, kind: 'hook-note', atStart: true, texts: ['kept'] });
    const unlisted = JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: 'plain' } });
    assert.deepEqual(transcriptReader.entry(unlisted), { ...BARE, kind: 'hook-note', atStart: false, texts: [] });
  });

  it('reads the scheduled jobs live when the host compacted, those an earlier session armed after its own', () => {
    const own = { id: 'j-1', cron: '3 13 * * *', prompt: 'daily check', recurring: true, createdAt: AT_MS };
    const armed = { id: 'j-2', cron: '17 5 26 10 *', prompt: 'look once', recurring: false, createdAt: AT_MS + 1 };
    const line = JSON.stringify({ type: 'attachment', timestamp: AT, attachment: { type: 'session_cron_carry', tasks: [own], otherArmed: [armed] } });
    assert.deepEqual(transcriptReader.entry(line), { ...BARE, at: AT_MS, kind: 'scheduled-carry', jobs: [own, armed] });
    // Only a job marked as not recurring runs once; one without its id, schedule, prompt or time is no job.
    const whole = { id: 'j-3', cron: '* * * * *', prompt: 'p', createdAt: 5 };
    const tasks = [whole, { ...whole, id: undefined }, { ...whole, cron: 7 }, { ...whole, prompt: undefined }, { ...whole, createdAt: AT }, 'text', null];
    assert.deepEqual(transcriptReader.entry(JSON.stringify({ type: 'attachment', attachment: { type: 'session_cron_carry', tasks } })), {
      ...BARE,
      kind: 'scheduled-carry',
      jobs: [{ ...whole, recurring: true }],
    });
    for (const lists of [{}, { tasks: 'none', otherArmed: 7 }]) {
      const empty = JSON.stringify({ type: 'attachment', attachment: { type: 'session_cron_carry', ...lists } });
      assert.deepEqual(transcriptReader.entry(empty), { ...BARE, kind: 'scheduled-carry', jobs: [] }, empty);
    }
  });

  it('reads what the host told the session of its machine, with the scratchpad folder when it names one', () => {
    const line = JSON.stringify({ type: 'attachment', timestamp: AT, attachment: { type: 'environment', snapshot: { workingDirectory: '/work', scratchpadDirectory: '/tmp/s-1/scratchpad' } } });
    assert.deepEqual(transcriptReader.entry(line), { ...BARE, at: AT_MS, kind: 'environment', scratchpad: '/tmp/s-1/scratchpad' });
    for (const told of [{}, { snapshot: { workingDirectory: '/work' } }, { snapshot: { scratchpadDirectory: 7 } }, { snapshot: '/tmp/s-1/scratchpad' }]) {
      const untold = JSON.stringify({ type: 'attachment', attachment: { type: 'environment', ...told } });
      assert.deepEqual(transcriptReader.entry(untold), { ...BARE, kind: 'environment', scratchpad: undefined }, untold);
    }
  });

  it("reads the host's own switch of the session's model, with the model it left and why when the line says", () => {
    const line = JSON.stringify({ type: 'system', subtype: 'model_refusal_fallback', isSidechain: false, uuid: 'u-1', timestamp: AT, originalModel: 'model-a', fallbackModel: 'model-b', apiRefusalCategory: 'cyber' });
    assert.deepEqual(transcriptReader.entry(line), { ...BARE, at: AT_MS, id: 'u-1', thread: 'main', kind: 'model-switch', from: 'model-a', to: 'model-b', reason: 'cyber' });
    const bare = JSON.stringify({ type: 'system', fallbackModel: 'model-b', originalModel: 7 });
    assert.deepEqual(transcriptReader.entry(bare), { ...BARE, kind: 'model-switch', from: undefined, to: 'model-b', reason: undefined });
    const ended = JSON.stringify({ type: 'system', subtype: 'turn_duration', fallbackModel: 'model-b' });
    assert.equal(transcriptReader.entry(ended)?.kind, 'turn-end', "a turn's end stays one");
  });

  it('reads a prompt the host queued, with its text when the line holds one', () => {
    const line = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: AT, sessionId: 's-1', content: 'daily check' });
    assert.deepEqual(transcriptReader.entry(line), { ...BARE, at: AT_MS, session: 's-1', kind: 'queued-prompt', text: 'daily check' });
    for (const content of [undefined, 7, ['daily check']]) {
      const untold = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content });
      assert.deepEqual(transcriptReader.entry(untold), { ...BARE, kind: 'queued-prompt', text: undefined }, untold);
    }
  });

  it("reads the session's title, the person's own or the one the host made up, as it was written", () => {
    const named = JSON.stringify({ type: 'custom-title', customTitle: ' Host ports ', sessionId: 's-1' });
    assert.deepEqual(transcriptReader.entry(named), { ...BARE, session: 's-1', kind: 'title', by: 'person', text: ' Host ports ' });
    const made = JSON.stringify({ type: 'ai-title', aiTitle: 'Moving the readers', sessionId: 's-1' });
    assert.deepEqual(transcriptReader.entry(made), { ...BARE, session: 's-1', kind: 'title', by: 'host', text: 'Moving the readers' });
    const blank = JSON.stringify({ type: 'custom-title', customTitle: '' });
    assert.deepEqual(transcriptReader.entry(blank), { ...BARE, kind: 'title', by: 'person', text: '' });
  });

  it('names the type of every other line, so none is lost unseen', () => {
    const others: readonly (readonly [Readonly<Record<string, unknown>>, string | undefined])[] = [
      [{ type: 'attachment', attachment: { type: 'date_change', newDate: '2026-01-06' } }, 'attachment'],
      [{ type: 'attachment', attachment: 'environment' }, 'attachment'],
      [{ type: 'attachment' }, 'attachment'],
      [{ type: 'system', subtype: 'api_error' }, 'system'],
      [{ type: 'system', originalModel: 'model-a', fallbackModel: 7 }, 'system'],
      [{ type: 'system' }, 'system'],
      [{ type: 'system', subtype: 7 }, 'system'],
      [{ type: 'queue-operation', operation: 'dequeue' }, 'queue-operation'],
      [{ type: 'queue-operation', content: 'go' }, 'queue-operation'],
      [{ type: 'custom-title', customTitle: 7 }, 'custom-title'],
      [{ type: 'custom-title', aiTitle: 'Moving the readers' }, 'custom-title'],
      [{ type: 'ai-title' }, 'ai-title'],
      [{ type: 'agent-name', agentName: 'ports' }, 'agent-name'],
      [{ type: 'user' }, 'user'],
      [{ type: 'user', message: 'go' }, 'user'],
      [{ type: 'assistant', message: [] }, 'assistant'],
      [{ subtype: 'compact_boundary' }, undefined],
      [{ type: 7 }, undefined],
      [{}, undefined],
    ];
    for (const [entry, type] of others) {
      assert.deepEqual(transcriptReader.entry(JSON.stringify(entry)), { ...BARE, kind: 'other', type }, JSON.stringify(entry));
    }
    assert.deepEqual(transcriptReader.entry(JSON.stringify({ type: 'file-history-snapshot', timestamp: AT })), { ...BARE, at: AT_MS, kind: 'other', type: 'file-history-snapshot' });
  });

  it('says a torn line and a line that is no object are unread, and a blank line is nothing', () => {
    assert.deepEqual(transcriptReader.entry('{"type":"user","message":{"role":"us'), { kind: 'unread', reason: 'damaged' });
    assert.deepEqual(transcriptReader.entry('not json'), { kind: 'unread', reason: 'damaged' });
    for (const line of ['[1]', '7', 'null', '"text"', 'true']) {
      assert.deepEqual(transcriptReader.entry(line), { kind: 'unread', reason: 'not-an-object' }, line);
    }
    for (const line of ['', ' ', '\r', ' \t\r']) {
      assert.equal(transcriptReader.entry(line), undefined, JSON.stringify(line));
      assert.equal(transcriptReader.entry(line, ['other']), undefined, JSON.stringify(line));
    }
    assert.deepEqual(transcriptReader.entry(`${compactLine(AT)}\r`), { ...BARE, at: AT_MS, kind: 'compact' });
  });
});

describe('reading only some kinds of entry', () => {
  const lines = {
    input: promptLine(AT),
    reply: replyLine({ id: 'm-1', at: AT, usage: { input: 1 } }),
    compact: compactLine(AT),
    'turn-end': systemLine(AT),
    continued: JSON.stringify({ type: 'continued-in', timestamp: AT, continuedInSessionId: 's-2' }),
    'hook-note': sessionStartNoteLine(AT, ['note']),
    'scheduled-carry': JSON.stringify({ type: 'attachment', timestamp: AT, attachment: { type: 'session_cron_carry', tasks: [] } }),
    environment: JSON.stringify({ type: 'attachment', timestamp: AT, attachment: { type: 'environment', snapshot: {} } }),
    'queued-prompt': JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: AT, content: 'go' }),
    'model-switch': JSON.stringify({ type: 'system', timestamp: AT, originalModel: 'model-a', fallbackModel: 'model-b' }),
    title: JSON.stringify({ type: 'custom-title', timestamp: AT, customTitle: 'Host ports' }),
    other: JSON.stringify({ type: 'system', subtype: 'api_error', timestamp: AT }),
  } as const;
  const kinds = ['input', 'reply', 'compact', 'turn-end', 'continued', 'hook-note', 'scheduled-carry', 'environment', 'queued-prompt', 'model-switch', 'title', 'other'] as const;

  it('gives a line of a named kind as it reads without the filter', () => {
    for (const kind of kinds) {
      const whole = transcriptReader.entry(lines[kind]);
      assert.equal(whole?.kind, kind);
      assert.deepEqual(transcriptReader.entry(lines[kind], [kind]), whole);
      assert.deepEqual(transcriptReader.entry(lines[kind], kinds), whole);
    }
  });

  it('gives nothing for a line of a kind not named', () => {
    for (const kind of kinds) {
      for (const other of kinds.filter((name) => name !== kind)) {
        assert.equal(transcriptReader.entry(lines[kind], [other]), undefined, `${kind} read as only ${other}`);
      }
      assert.equal(transcriptReader.entry(lines[kind], []), undefined);
    }
  });

  it('is not misled by a line that quotes another kind of line', () => {
    const quoting = textLine('u-1', [lines.input, lines.compact]);
    assert.equal(transcriptReader.entry(quoting, ['input', 'compact', 'hook-note']), undefined);
    assert.equal(transcriptReader.entry(quoting, ['reply'])?.kind, 'reply');
    const named = userLine({}, 'the "compact_boundary", "hook_additional_context", "session_cron_carry", "type":"environment", "type":"queue-operation", "fallbackModel" and "type":"custom-title" lines');
    assert.equal(transcriptReader.entry(named, ['compact', 'hook-note', 'scheduled-carry', 'environment', 'queued-prompt', 'model-switch', 'title']), undefined);
  });

  it('still says a damaged line that could be of a named kind is unread, and passes one that could not', () => {
    const torn = lines.input.slice(0, -5);
    assert.deepEqual(transcriptReader.entry(torn, ['input']), { kind: 'unread', reason: 'damaged' });
    assert.equal(transcriptReader.entry(torn, ['reply', 'compact']), undefined);
    assert.deepEqual(transcriptReader.entry(torn, ['other']), { kind: 'unread', reason: 'damaged' });
  });
});

describe('the recorded session read as entries', () => {
  const recording = loadRecording('claude-code', new FolderNames({ cwd: resolve('/', 'work', 'app'), temp: resolve('/', 'tmp'), home: resolve('/', 'u') }));
  const lines = recording.transcripts.flatMap((transcript) =>
    transcript.text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line, index) => ({ where: `${transcript.file} line ${index + 1}`, line })),
  );
  const kinds = ['input', 'reply', 'compact', 'turn-end', 'continued', 'hook-note', 'scheduled-carry', 'environment', 'queued-prompt', 'model-switch', 'title', 'other'] as const;

  it('reads every line the host wrote: none is damaged, and the session has inputs and replies in both threads', () => {
    assert.equal(recording.transcripts.length >= 2, true, 'the session and a helper were recorded');
    const read = lines.map(({ where, line }) => ({ where, entry: transcriptReader.entry(line) }));
    assert.deepEqual(
      read.filter(({ entry }) => entry === undefined || entry.kind === 'unread').map(({ where }) => where),
      [],
    );
    const seen = new Set(read.map(({ entry }) => (entry === undefined || entry.kind === 'unread' ? 'none' : `${entry.kind} ${entry.thread ?? 'unmarked'}`)));
    for (const expected of ['input main', 'reply main', 'input helper', 'reply helper', 'turn-end main']) {
      assert.equal(seen.has(expected), true, `no ${expected} line in the recording`);
    }
  });

  it('reads each line alike with the filter of its own kind, and as nothing with any other', () => {
    for (const { where, line } of lines) {
      const whole = transcriptReader.entry(line);
      for (const kind of kinds) {
        assert.deepEqual(transcriptReader.entry(line, [kind]), whole?.kind === kind ? whole : undefined, `${where} read as only ${kind}`);
      }
    }
  });
});
