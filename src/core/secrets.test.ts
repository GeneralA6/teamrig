import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from './secrets.ts';

/** Secret-shaped strings are assembled at runtime so none sits in the source. */
const join = (...parts: string[]) => parts.join('');

describe('SecretScanner', () => {
  const scanner = new SecretScanner(['tok_[a-z0-9]{8}']);

  it('refuses credentials in URLs and key=value secrets', () => {
    assert.equal(scanner.find(join('see amqp://', 'app', ':', 's3cret', '@', 'queue.local:5672'))?.id, 'url-credentials');
    assert.equal(scanner.find(join('PASS', 'WORD', '=', 'abc'))?.id, 'secret-assignment');
    assert.equal(scanner.find(join('api', '_key', ': ', 'xyz'))?.id, 'secret-assignment');
  });

  it('refuses vendor tokens, whatever the config adds', () => {
    const bare = new SecretScanner();
    assert.equal(bare.find(join('use ', 'ghp', '_', 'a1'.repeat(18), ' for CI'))?.id, 'github-token');
    assert.equal(bare.find(join('key ', 'AKIA', 'ABCDEFGH12345678'))?.id, 'aws-key');
    assert.equal(bare.find(join('sk-', 'ant-', 'c'.repeat(30)))?.id, 'anthropic-key');
  });

  it('adds the configured patterns, case-insensitively', () => {
    assert.equal(scanner.find(join('TOK', '_ABCD1234'))?.id, 'config-1');
    assert.equal(new SecretScanner().find(join('tok', '_abcd1234')), undefined);
  });

  it('lets ordinary text through', () => {
    assert.equal(scanner.find('rotate the password via the vault runbook'), undefined);
    assert.equal(scanner.find('https://example.test/path?a=1'), undefined);
    assert.equal(scanner.refusal('note', 'merged at 3f9a1c0e7b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a'), undefined);
  });

  it('names the shape in a refusal, never the secret', () => {
    const token = join('ghp', '_', 'Zq9'.repeat(12));
    const refusal = scanner.refusal('ref', `see ${token}`);
    assert.equal(refusal, 'ref looks like it holds a secret (GitHub token); refer to where it is kept instead');
    assert.equal(refusal?.includes(token.slice(4)), false);
    assert.equal(scanner.refusal('title', join('TOK', '_ABCD1234')), 'title looks like it holds a secret (secret pattern from the team config); refer to where it is kept instead');
  });

  it('redacts each secret to the end of its word and keeps the rest of the line', () => {
    const token = join('ghp', '_', 'a'.repeat(36));
    assert.equal(scanner.redact(join('flow probe: password', '=', 'hunter2 then retry')), 'flow probe: [redacted password or key assignment] then retry');
    assert.equal(scanner.redact(`push with ${token}, twice: ${token}`), 'push with [redacted GitHub token] twice: [redacted GitHub token]');
    assert.equal(scanner.redact(join('key TOK', '_ABCD1234xyz ok')), 'key [redacted secret pattern from the team config] ok');
    assert.equal(scanner.redact('open flow since 23:10 UTC'), 'open flow since 23:10 UTC');
  });

  it('redacts an env-style assignment from its key word, keeping the name it ends', () => {
    assert.equal(scanner.redact(join('export DB_', 'PASSWORD', '=', 'hunter2 then retry')), 'export DB_[redacted password or key assignment] then retry');
  });
});
