import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promptLine, resultsLine, textLine, transcript } from '../testing/transcript-lines.ts';
import { replyOf } from './reply.ts';

const AT = '2030-01-08T09:50:00.000Z';
/** A user line Claude Code adds as context inside a turn, which starts no turn. */
const META = JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: local command output follows.' } });

describe('replyOf', () => {
  it("joins the text the model wrote since the last turn's prompt, across tool calls and context lines", () => {
    const tail = transcript([
      promptLine(AT, 'last time'),
      textLine('a0', ['An older reply.']),
      promptLine(AT, 'fix the build'),
      textLine('a1', ['Looking at the log.'], ['t1']),
      resultsLine(AT, [{ id: 't1', text: 'exit 1' }]),
      META,
      textLine('a2', ['Fixed the import.']),
    ]);
    assert.deepEqual(replyOf(tail, undefined, true), { text: 'Looking at the log.\n\nFixed the import.', upTo: 'a2', cut: false });
  });

  it('starts after the entry an earlier reply of the same turn took, as at a stop a hook sent back', () => {
    const tail = transcript([promptLine(AT, 'fix the build'), textLine('a1', ['Part one.']), textLine('a2', ['Part two.'])]);
    assert.deepEqual(replyOf(tail, 'a1', true), { text: 'Part two.', upTo: 'a2', cut: false });
  });

  it('is undefined when the model wrote no text since, as a turn of tool calls only', () => {
    const tail = transcript([promptLine(AT, 'fix the build'), textLine('a1', ['Done.']), promptLine(AT, 'and the tests'), textLine('a2', [], ['t2'])]);
    assert.equal(replyOf(tail, undefined, true), undefined);
    assert.equal(replyOf(transcript([promptLine(AT), textLine('a1', ['Done.'])]), 'a1', true), undefined);
  });

  it('marks the reply cut when its turn began before the tail, but not when the tail is the whole transcript', () => {
    const tail = `{"type":"assistant","message":{"content":[{"type":"text","text":"torn"}]}}`.slice(20) + `\n${textLine('a1', ['The end of a long turn.'])}\n`;
    assert.deepEqual(replyOf(tail, undefined, false), { text: 'The end of a long turn.', upTo: 'a1', cut: true });
    assert.equal(replyOf(tail, undefined, true)?.cut, false);
  });
});
