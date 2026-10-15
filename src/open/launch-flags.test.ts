import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { launchFlags } from './launch-flags.ts';

describe('launchFlags', () => {
  it('passes the model and the effort that are set', () => {
    assert.deepEqual(launchFlags({ model: 'best', effort: 'xhigh' }), ['--model', 'best', '--effort', 'xhigh']);
    assert.deepEqual(launchFlags({ model: 'claude-opus-5-5[1m]' }), ['--model', 'claude-opus-5-5[1m]']);
    assert.deepEqual(launchFlags({ effort: 'low' }), ['--effort', 'low']);
  });

  it('passes nothing for unset keys and for the default model', () => {
    assert.deepEqual(launchFlags({}), []);
    assert.deepEqual(launchFlags({ model: 'default', effort: 'high' }), ['--effort', 'high']);
  });
});
