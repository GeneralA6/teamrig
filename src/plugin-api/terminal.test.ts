import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PANE_STATES, TERMINAL_REQUESTS, isPaneState, isTerminalRequest } from './terminal.ts';

describe('the terminal port', () => {
  it('names the protocol requests as the wire does', () => {
    assert.deepEqual(TERMINAL_REQUESTS, ['open', 'focus', 'close', 'restart', 'rename', 'deliver', 'isIdle', 'list']);
  });

  it('takes a request by its exact name only', () => {
    for (const request of TERMINAL_REQUESTS) {
      assert.equal(isTerminalRequest(request), true);
    }
    assert.equal(isTerminalRequest('isidle'), false);
    assert.equal(isTerminalRequest('adopt'), false);
    assert.equal(isTerminalRequest(undefined), false);
    assert.equal(isTerminalRequest(['open']), false);
  });

  it('keeps a draft apart from idle', () => {
    assert.deepEqual(PANE_STATES, ['idle', 'busy', 'asking', 'draft', 'gone']);
  });

  it('takes a pane state by its exact name only', () => {
    for (const state of PANE_STATES) {
      assert.equal(isPaneState(state), true);
    }
    assert.equal(isPaneState('Idle'), false);
    assert.equal(isPaneState('free'), false);
    assert.equal(isPaneState(0), false);
  });
});
