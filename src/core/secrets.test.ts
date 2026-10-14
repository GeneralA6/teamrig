import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from './secrets.ts';

/** Secret-shaped strings are assembled at runtime so none sits in the source. */
const join = (...parts: string[]) => parts.join('');

describe('SecretScanner', () => {
  const scanner = new SecretScanner(['tok_[a-z0-9]{8}']);

  it('refuses credentials in URLs and key=value secrets', () => {
    assert.ok(scanner.looksSecret(join('see amqp://', 'app', ':', 's3cret', '@', 'queue.local:5672')));
    assert.ok(scanner.looksSecret(join('PASS', 'WORD', '=', 'abc')));
    assert.ok(scanner.looksSecret(join('api', '_key', ': ', 'xyz')));
  });

  it('adds the configured patterns', () => {
    assert.ok(scanner.looksSecret(join('tok', '_abcd1234')));
    assert.equal(new SecretScanner().looksSecret(join('tok', '_abcd1234')), false);
  });

  it('lets ordinary text through', () => {
    assert.equal(scanner.looksSecret('rotate the password via the vault runbook'), false);
    assert.equal(scanner.looksSecret('https://example.test/path?a=1'), false);
  });
});
