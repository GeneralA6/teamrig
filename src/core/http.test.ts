import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchFailure, isHttpsUrl } from './http.ts';

describe('isHttpsUrl', () => {
  it('is true only for an absolute https URL', () => {
    assert.deepEqual(
      ['https://chat.example/hook', 'HTTPS://chat.example/hook', 'http://chat.example/hook', 'https:/', '//chat.example/hook', ''].map(isHttpsUrl),
      [true, true, false, false, false, false],
    );
  });
});

describe('fetchFailure', () => {
  it('names a timeout by its length', () => {
    assert.equal(fetchFailure('the webhook', new DOMException('The operation timed out', 'TimeoutError'), 50), 'the webhook did not answer within 50 ms');
  });

  it("names the cause's code, and never the error's own message, which can quote the URL", () => {
    const refused = new TypeError('fetch failed: https://chat.example/hook-token', { cause: { code: 'ECONNREFUSED' } });
    assert.equal(fetchFailure('the webhook', refused, 50), 'the webhook could not be reached (ECONNREFUSED)');
    assert.equal(fetchFailure('the server', new TypeError('fetch failed: https://chat.example/hook-token'), 50), 'the server could not be reached');
    assert.equal(fetchFailure('the server', 'https://chat.example/hook-token', 50), 'the server could not be reached');
  });
});
