import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isGuardThreadMessage, isGuardThreadRun, messageOf } from './guard-thread-messages.ts';

describe('isGuardThreadMessage', () => {
  it('takes each message the guard thread sends', () => {
    for (const message of [
      { kind: 'loaded' },
      { kind: 'load-failed', message: 'x' },
      { kind: 'crashed', message: 'x' },
      { kind: 'stdout', line: '{}' },
      { kind: 'stderr', line: '' },
      { kind: 'answered', code: 0 },
    ]) {
      assert.equal(isGuardThreadMessage(message), true, JSON.stringify(message));
    }
  });

  it('refuses a message with a wrong or missing field, an unknown kind, or no object', () => {
    for (const value of [
      { kind: 'crashed' },
      { kind: 'stdout', line: 1 },
      { kind: 'answered', code: '0' },
      { kind: 'done' },
      ['loaded'],
      null,
      'loaded',
    ]) {
      assert.equal(isGuardThreadMessage(value), false, JSON.stringify(value));
    }
  });
});

describe('isGuardThreadRun', () => {
  it('takes string arguments and a script, and refuses anything else', () => {
    assert.equal(isGuardThreadRun({ argv: ['hook', 'push-guard'], script: 'main.js' }), true);
    assert.equal(isGuardThreadRun({ argv: [], script: 'main.js' }), true);
    assert.equal(isGuardThreadRun({ argv: ['hook', 2], script: 'main.js' }), false);
    assert.equal(isGuardThreadRun({ argv: 'hook', script: 'main.js' }), false);
    assert.equal(isGuardThreadRun({ argv: ['hook'] }), false);
    assert.equal(isGuardThreadRun(undefined), false);
  });
});

describe('messageOf', () => {
  it("reads an error's message, and anything else as text", () => {
    assert.equal(messageOf(new Error('broken')), 'broken');
    assert.equal(messageOf('plain'), 'plain');
    assert.equal(messageOf(7), '7');
  });
});
