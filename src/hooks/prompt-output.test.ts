import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promptOutput } from './prompt-output.ts';

describe('promptOutput', () => {
  it('prints the lines as they are when the tab gets no title', () => {
    assert.deepEqual(promptOutput(['one', 'two'], undefined), ['one', 'two']);
    assert.deepEqual(promptOutput([], undefined), []);
  });

  it('carries the lines as additionalContext beside the title, in one JSON line', () => {
    const [line, ...rest] = promptOutput(['one', 'two\nthree'], 'app-alpha');
    assert.deepEqual(rest, []);
    assert.deepEqual(JSON.parse(line ?? ''), {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'one\ntwo\nthree', sessionTitle: 'app-alpha' },
    });
  });

  it('gives only the title when there is nothing to say', () => {
    assert.deepEqual(
      promptOutput([], 'app-alpha').map((line): unknown => JSON.parse(line)),
      [{ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'app-alpha' } }],
    );
  });
});
