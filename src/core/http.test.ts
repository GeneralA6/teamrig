import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isHttpsUrl } from './http.ts';

describe('isHttpsUrl', () => {
  it('is true only for an absolute https URL', () => {
    assert.deepEqual(
      ['https://chat.example/hook', 'HTTPS://chat.example/hook', 'http://chat.example/hook', 'https:/', '//chat.example/hook', ''].map(isHttpsUrl),
      [true, true, false, false, false, false],
    );
  });
});
