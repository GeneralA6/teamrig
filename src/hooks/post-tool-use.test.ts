import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { postToolUseContext, toolResponseOf } from './post-tool-use.ts';

describe('toolResponseOf', () => {
  it('reads the result as the object or as its JSON text', () => {
    assert.deepEqual(toolResponseOf({ success: true }), { success: true });
    assert.deepEqual(toolResponseOf('{"success":false}'), { success: false });
  });

  it('gives undefined for text that is no JSON record, and for no record at all', () => {
    assert.equal(toolResponseOf('sent'), undefined);
    assert.equal(toolResponseOf('[1]'), undefined);
    assert.equal(toolResponseOf(undefined), undefined);
  });
});

describe('postToolUseContext', () => {
  it('hands the line to the model as PostToolUse context', () => {
    assert.deepEqual(JSON.parse(postToolUseContext('the line')), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'the line' } });
  });
});
