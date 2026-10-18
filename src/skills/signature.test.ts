import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signatureOf } from './signature.ts';

describe('signatureOf', () => {
  it('compiles each Signature line of the body, CRLF and trailing spaces included', () => {
    const text = '---\nname: alpha-a\n---\nSignature: `cli\\.ts inbox read`\r\nSignature:`teamrig inbox read`  \nOwner: alpha\n';
    const signature = signatureOf({ name: 'alpha-a', text });
    assert.equal(signature.name, 'alpha-a');
    assert.deepEqual(signature.patterns.map((pattern) => pattern.source), ['cli\\.ts inbox read', 'teamrig inbox read']);
    assert.deepEqual(signature.invalid, []);
  });

  it('reports a source that is not a valid regex, and skips lines that only mention a signature', () => {
    const text = 'Signature: `(open`\nA Signature: `x` mid-line\nSignature: no backticks\nSignature: `ok`';
    const signature = signatureOf({ name: 'alpha-a', text });
    assert.deepEqual(signature.patterns.map((pattern) => pattern.source), ['ok']);
    assert.deepEqual(signature.invalid, ['(open']);
  });

  it('has no patterns for a skill without a Signature line', () => {
    assert.deepEqual(signatureOf({ name: 'alpha-a', text: 'Owner: alpha' }), { name: 'alpha-a', patterns: [], invalid: [] });
  });
});
