import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Scrubber } from './scrub.ts';
import { cutStandIn, fixtureTranscript, MAX_BOOKKEEPING_STRING } from './transcript.ts';

const LONG = 'x'.repeat(MAX_BOOKKEEPING_STRING + 1);
const SHORT = 'y'.repeat(MAX_BOOKKEEPING_STRING);

function scrubber(): Scrubber {
  return new Scrubber({ cwd: '/rec/base/cwd', temp: '/rec/base', home: '', user: '', host: '' });
}

function lines(...entries: readonly unknown[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
}

describe('fixtureTranscript', () => {
  it("keeps the session's own lines whole, whatever their length", () => {
    const entries = [
      { type: 'user', message: { role: 'user', content: LONG } },
      { type: 'assistant', message: { content: [{ type: 'text', text: LONG }] } },
      { type: 'system', subtype: 'compact_boundary', content: LONG },
      { type: 'queue-operation', operation: 'enqueue', content: LONG },
      { type: 'last-prompt', lastPrompt: LONG },
    ];
    assert.deepEqual(fixtureTranscript('session', lines(...entries), scrubber()), { text: lines(...entries), cut: 0 });
  });

  it('cuts every long string of a bookkeeping line to a stand-in that says its length, and counts them', () => {
    const text = lines(
      { type: 'attachment', attachment: { type: 'skill_listing', content: LONG, names: ['Read', LONG], count: 2, isInitial: true, extra: null } },
      { type: 'user', message: { content: 'hello' } },
      { type: 'api-request', system: [{ text: `${LONG}!` }], model: 'haiku' },
      { note: LONG },
    );
    const stand = cutStandIn(LONG.length);
    assert.equal(stand, '[recorded: 121 characters]');
    assert.deepEqual(fixtureTranscript('session', text, scrubber()), {
      text: lines(
        { type: 'attachment', attachment: { type: 'skill_listing', content: stand, names: ['Read', stand], count: 2, isInitial: true, extra: null } },
        { type: 'user', message: { content: 'hello' } },
        { type: 'api-request', system: [{ text: cutStandIn(LONG.length + 1) }], model: 'haiku' },
        { note: stand },
      ),
      cut: 4,
    });
  });

  it('keeps a bookkeeping string at the limit', () => {
    const text = lines({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [SHORT] } });
    assert.deepEqual(fixtureTranscript('session', text, scrubber()), { text, cut: 0 });
  });

  it('scrubs each line before it measures one, so a path is kept or cut the same on every machine', () => {
    const path = `/rec/base/cwd/${'d'.repeat(MAX_BOOKKEEPING_STRING - '{{cwd}}/'.length)}`;
    assert.ok(path.length > MAX_BOOKKEEPING_STRING);
    const text = lines({ type: 'attachment', attachment: { type: 'file', filename: path } }, { type: 'user', cwd: '/rec/base/cwd' });
    assert.deepEqual(fixtureTranscript('session', text, scrubber()), {
      text: lines({ type: 'attachment', attachment: { type: 'file', filename: path.replace('/rec/base/cwd', '{{cwd}}') } }, { type: 'user', cwd: '{{cwd}}' }),
      cut: 0,
    });
  });

  it('skips blank lines and refuses a line that is no JSON object, naming it', () => {
    assert.deepEqual(fixtureTranscript('session', '\n{"type":"mode"}\n\n', scrubber()), { text: '{"type":"mode"}\n', cut: 0 });
    assert.throws(() => fixtureTranscript('transcripts/helper-1.jsonl', '{"type":"mode"}\n[1]\n', scrubber()), {
      message: 'transcripts/helper-1.jsonl line 2 is not a JSON object',
    });
  });
});
