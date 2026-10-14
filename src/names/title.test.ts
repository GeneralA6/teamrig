import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { customTitleOf, sessionTitleOf, TRANSCRIPT_TAIL_BYTES } from './title.ts';

const TRANSCRIPT = join('/', 'home', 'transcripts', 'session.jsonl');

function entries(...lines: readonly object[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

describe('customTitleOf', () => {
  it('finds the newest title the user gave, past later turns', () => {
    const text = entries(
      { type: 'custom-title', customTitle: 'scout' },
      { type: 'user', message: 'hello' },
      { type: 'custom-title', customTitle: ' ranger ' },
      { type: 'assistant', message: 'hi' },
    );
    assert.equal(customTitleOf(text), 'ranger');
  });

  it('ignores made-up titles, agent names, a prompt that quotes the entry, empty titles and torn lines', () => {
    const text = [
      'custom-title","customTitle":"torn"}',
      JSON.stringify({ type: 'ai-title', aiTitle: 'Fixing the build' }),
      JSON.stringify({ type: 'agent-name', agentName: 'scout' }),
      JSON.stringify({ type: 'user', message: '{"type":"custom-title","customTitle":"fake"}' }),
      JSON.stringify({ type: 'custom-title', customTitle: '  ' }),
      JSON.stringify({ type: 'custom-title', customTitle: 7 }),
    ].join('\n');
    assert.equal(customTitleOf(text), undefined);
  });
});

describe('sessionTitleOf', () => {
  it("takes the payload's title first, and reads no transcript for it", async () => {
    const files = new MemoryFiles({ [TRANSCRIPT]: entries({ type: 'custom-title', customTitle: 'scout' }) });
    assert.equal(await sessionTitleOf({ session_title: ' ranger', transcript_path: TRANSCRIPT }, files), 'ranger');
  });

  it("falls back to the end of the transcript, and only its end", async () => {
    const turns = entries({ type: 'user', message: 'x'.repeat(TRANSCRIPT_TAIL_BYTES) });
    const files = new MemoryFiles({ [TRANSCRIPT]: `${entries({ type: 'custom-title', customTitle: 'scout' })}${turns}` });
    assert.equal(await sessionTitleOf({ session_title: '', transcript_path: TRANSCRIPT }, files), undefined);
    await files.append(TRANSCRIPT, entries({ type: 'custom-title', customTitle: 'ranger' }));
    assert.equal(await sessionTitleOf({ transcript_path: TRANSCRIPT }, files), 'ranger');
  });

  it('has no title without a payload, a transcript path or a transcript file', async () => {
    const files = new MemoryFiles();
    assert.equal(await sessionTitleOf('not a payload', files), undefined);
    assert.equal(await sessionTitleOf({ transcript_path: '' }, files), undefined);
    assert.equal(await sessionTitleOf({ transcript_path: TRANSCRIPT }, files), undefined);
  });
});
