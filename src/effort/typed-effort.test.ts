import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { effortLines, promptLine, transcript } from '../testing/transcript-lines.ts';
import { typedEffortsOf } from './typed-effort.ts';

const SESSION = 'claude-1';
const AT = '2026-11-06T14:50:10.721Z';

describe('typedEffortsOf', () => {
  it('reads a typed level from the reply Claude Code wrote under the command', () => {
    const text = transcript([promptLine(AT), ...effortLines({ uuid: 'u1', at: AT, sessionId: SESSION, args: 'medium', set: 'medium' })]);
    assert.deepEqual(typedEffortsOf(text, SESSION), [{ uuid: 'u1', at: Date.parse(AT), level: 'medium' }]);
  });

  it('takes a picked level from the reply, as a bare /effort names none', () => {
    const text = transcript(effortLines({ uuid: 'u1', at: AT, sessionId: SESSION, set: 'xhigh' }));
    assert.deepEqual(
      typedEffortsOf(text, SESSION).map((typed) => typed.level),
      ['xhigh'],
    );
  });

  it('keeps every typed level, oldest first', () => {
    const later = '2026-11-06T15:00:00.000Z';
    const text = transcript([...effortLines({ uuid: 'u1', at: AT, sessionId: SESSION, args: 'low', set: 'low' }), ...effortLines({ uuid: 'u2', at: later, sessionId: SESSION, args: 'high', set: 'high' })]);
    assert.deepEqual(
      typedEffortsOf(text, SESSION).map((typed) => [typed.uuid, typed.level]),
      [
        ['u1', 'low'],
        ['u2', 'high'],
      ],
    );
  });

  it('leaves out a command with no reply, or a reply naming no level teamrig knows', () => {
    const text = transcript([...effortLines({ uuid: 'u1', at: AT, sessionId: SESSION }), ...effortLines({ uuid: 'u2', at: AT, sessionId: SESSION, args: 'auto', set: 'auto' })]);
    assert.deepEqual(typedEffortsOf(text, SESSION), []);
  });

  it('never counts what no one typed in this session: a plugin, a peer, a helper or another session', () => {
    const text = transcript([
      ...effortLines({ uuid: 'u1', at: AT, sessionId: SESSION, args: 'low', set: 'low', extra: { origin: { kind: 'plugin' } } }),
      ...effortLines({ uuid: 'u2', at: AT, sessionId: SESSION, args: 'low', set: 'low', extra: { isMeta: true } }),
      ...effortLines({ uuid: 'u3', at: AT, sessionId: SESSION, args: 'low', set: 'low', extra: { isSidechain: true } }),
      ...effortLines({ uuid: 'u4', at: AT, sessionId: 'claude-2', args: 'low', set: 'low' }),
    ]);
    assert.deepEqual(typedEffortsOf(text, SESSION), []);
  });

  it('never counts a tool result or a prompt that quotes the command', () => {
    const quoted = '<command-name>/effort</command-name> then <local-command-stdout>Set effort level to low</local-command-stdout>';
    const own = { isSidechain: false, type: 'user', sessionId: SESSION, parentUuid: null, timestamp: AT };
    const result = JSON.stringify({ ...own, uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: quoted }] } });
    const prompt = JSON.stringify({ ...own, uuid: 'u2', message: { role: 'user', content: `see ${quoted}` } });
    assert.deepEqual(typedEffortsOf(transcript([result, prompt]), SESSION), []);
  });

  it('skips a torn first line of a tail read', () => {
    const [command, reply] = effortLines({ uuid: 'u1', at: AT, sessionId: SESSION, args: 'low', set: 'low' });
    assert.ok(command !== undefined && reply !== undefined);
    const torn = transcript([command.slice(20), reply]);
    assert.deepEqual(typedEffortsOf(torn, SESSION), []);
    const whole = transcript([command.slice(20), ...effortLines({ uuid: 'u2', at: AT, sessionId: SESSION, args: 'max', set: 'max' })]);
    assert.deepEqual(
      typedEffortsOf(whole, SESSION).map((typed) => typed.level),
      ['max'],
    );
  });
});
