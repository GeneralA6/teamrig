import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../exec/digest.ts';
import { PromptSecrets } from './prompt-secrets.ts';

/** Secret-shaped strings are assembled at runtime so none sits in the source for the scrub to flag. */
const join = (...parts: string[]): string => parts.join('');
const TOKEN = join('gh', 'p_', 'a1'.repeat(18));
const PASSWORD = join('s3', 'cret', 'Value9');

describe('PromptSecrets', () => {
  const secrets = new PromptSecrets(['tok_[a-z0-9]{8}']);

  it('finds a token by its shape and keeps its hash, never the value', () => {
    const found = secrets.secretsIn(join('use ', TOKEN, ' for the CI run'));
    assert.deepEqual(found, [{ id: 'github-token', description: 'GitHub token', hash: sha256Hex(TOKEN) }]);
    assert.equal(JSON.stringify(found).includes(TOKEN), false);
  });

  it('hashes only the secret a framing shape holds, once however often it appears', () => {
    const text = join('try https://app:', PASSWORD, '@queue.local then amqp://other:', PASSWORD, '@mq.local');
    assert.deepEqual(
      secrets.secretsIn(text).map(({ id, hash }) => ({ id, hash })),
      [{ id: 'url-credentials', hash: sha256Hex(PASSWORD) }],
    );
    const header = join('curl -H "Authorization: ', 'Bearer ', 'q7Wd'.repeat(5), '" https://x');
    assert.deepEqual(
      secrets.secretsIn(header).map(({ hash }) => hash),
      [sha256Hex('q7Wd'.repeat(5))],
    );
  });

  it('lets a placeholder or a short word in a framing shape through', () => {
    for (const text of ['https://user:<pass>@host', 'https://u:p@host', 'https://u:changeme@host', 'https://u:*****@host', 'https://u:${PASS}@host']) {
      assert.deepEqual(secrets.secretsIn(text), [], text);
    }
  });

  it('lets a prose assignment through: a prompt is not refused for saying password: x', () => {
    assert.deepEqual(secrets.secretsIn(join('the db pass', 'word: ', 'hunter22', ' is in the vault runbook')), []);
  });

  it('adds the configured patterns, case-insensitively', () => {
    const configured = join('TOK', '_ABCD1234');
    assert.deepEqual(
      secrets.secretsIn(configured).map(({ id, hash }) => ({ id, hash })),
      [{ id: 'config-1', hash: sha256Hex(configured) }],
    );
    assert.deepEqual(new PromptSecrets().secretsIn(configured), []);
  });

  it('names only the wanted hashes a text holds', () => {
    const text = join(TOKEN, ' and https://app:', PASSWORD, '@host');
    assert.deepEqual(secrets.hashesIn(text, new Set([sha256Hex(PASSWORD), sha256Hex('elsewhere')])), [sha256Hex(PASSWORD)]);
    assert.deepEqual(secrets.hashesIn('nothing here', new Set([sha256Hex(PASSWORD)])), []);
  });

  it('lets an ordinary prompt through', () => {
    assert.deepEqual(secrets.secretsIn('merge T1481 after the suite passes, then tell the team about https://example.test/a@b'), []);
  });
});
