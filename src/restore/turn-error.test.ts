import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apiErrorLine, promptLine, textLine, transcript } from '../testing/transcript-lines.ts';
import { turnErrorOf } from './turn-error.ts';

const TAB = '0123abcd-0000-4000-8000-00000000000a';

/** A tail reader that fails the spec when the decision should not have read the transcript. */
async function noTail(): Promise<string | undefined> {
  return assert.fail('the payload decides; the transcript is not read');
}

describe('turnErrorOf', () => {
  it("takes the payload's error over the transcript", async () => {
    assert.equal(await turnErrorOf({ error: 'authentication_failed' }, noTail), 'authentication_failed');
    assert.equal(await turnErrorOf({ error: 'overloaded' }, noTail), 'overloaded');
  });

  it("falls back to the transcript's last assistant record when the payload names no error", async () => {
    const failedTurn = transcript([promptLine('2030-01-08T06:00:00Z'), apiErrorLine('2030-01-08T06:00:14Z', TAB)]);
    assert.equal(await turnErrorOf({}, async () => failedTurn), 'authentication_failed');
    // A torn first line, as a tail cut mid-record leaves it, is skipped.
    assert.equal(await turnErrorOf({}, async () => `ssistant","error":"x"}\n${failedTurn}`), 'authentication_failed');
    const serverError = transcript([apiErrorLine('2030-01-08T06:00:14Z', TAB, 'server_error', 'API Error: 500')]);
    assert.equal(await turnErrorOf({}, async () => serverError), 'server_error');
  });

  it('names no error when the model answered since the last failure, or there is no transcript', async () => {
    const answeredSince = transcript([apiErrorLine('2030-01-08T06:00:14Z', TAB), promptLine('2030-01-08T08:20:00Z'), textLine('u2', ['done'])]);
    assert.equal(await turnErrorOf({}, async () => answeredSince), undefined);
    assert.equal(await turnErrorOf({}, async () => undefined), undefined);
  });
});
