import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { secretValueOf } from './secret-key.ts';

const URL = 'https://chat.example/api/webhooks/1/x';

describe('secretValueOf', () => {
  it("reads a key's double-quoted value from a Kubernetes secret's stringData block", () => {
    const text = ['apiVersion: v1', 'kind: Secret', 'stringData:', '  OTHER_KEY: "other"', `  PAGE_URL: "${URL}"`, ''].join('\r\n');
    assert.equal(secretValueOf(text, 'PAGE_URL'), URL);
  });

  it("reads a .env file's key, bare, single-quoted or after export", () => {
    assert.equal(secretValueOf(`PAGE_URL=${URL}\n`, 'PAGE_URL'), URL);
    assert.equal(secretValueOf(`PAGE_URL = '${URL}'`, 'PAGE_URL'), URL);
    assert.equal(secretValueOf(`export PAGE_URL="${URL}"`, 'PAGE_URL'), URL);
  });

  it('ends a bare value at a comment, but keeps a # inside the value', () => {
    assert.equal(secretValueOf(`PAGE_URL: ${URL}  # the alerts chat`, 'PAGE_URL'), URL);
    assert.equal(secretValueOf(`PAGE_URL: ${URL}#top`, 'PAGE_URL'), `${URL}#top`);
    assert.equal(secretValueOf(`PAGE_URL: "${URL}" # the alerts chat`, 'PAGE_URL'), URL);
  });

  it('takes the first line that sets the key, never one whose name only starts with it', () => {
    const text = [`PAGE_URL_OLD: "https://chat.example/old"`, `PAGE_URL: "${URL}"`, 'PAGE_URL: "https://chat.example/later"'].join('\n');
    assert.equal(secretValueOf(text, 'PAGE_URL'), URL);
  });

  it('is undefined for a missing key, a commented-out one or an unclosed quote, and empty for an empty value', () => {
    assert.equal(secretValueOf('OTHER_KEY: "x"', 'PAGE_URL'), undefined);
    assert.equal(secretValueOf(`# PAGE_URL: "${URL}"`, 'PAGE_URL'), undefined);
    assert.equal(secretValueOf(`PAGE_URL: "${URL}`, 'PAGE_URL'), undefined);
    assert.equal(secretValueOf('PAGE_URL: ""', 'PAGE_URL'), '');
    assert.equal(secretValueOf('PAGE_URL:', 'PAGE_URL'), '');
  });
});
