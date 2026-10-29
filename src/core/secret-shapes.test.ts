import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SECRET_TOKEN_PATTERNS } from './secret-patterns.ts';
import { SecretShapes, WRITE_TIME_SHAPES, isPlaceholderValue } from './secret-shapes.ts';

/** Secret-shaped strings are assembled at runtime so none sits in the source for the scrub to flag. */
const join = (...parts: string[]): string => parts.join('');
const TOKEN = join('gh', 'p_', 'a1'.repeat(18));
const PASSWORD = join('s3', 'cret', 'Value9');

describe('WRITE_TIME_SHAPES', () => {
  it('holds every token shape and the framed text shapes, not the prose assignment', () => {
    const ids = WRITE_TIME_SHAPES.map(({ id }) => id);
    for (const { id } of SECRET_TOKEN_PATTERNS) assert.ok(ids.includes(id), id);
    assert.ok(ids.includes('url-credentials'));
    assert.ok(ids.includes('auth-header'));
    assert.equal(ids.includes('secret-assignment'), false);
  });
});

describe('SecretShapes', () => {
  const shapes = new SecretShapes(['tok_[a-z0-9]{8}']);

  it('yields a token whole and a framed secret by its group, each with its shape', () => {
    const header = 'q7Wd'.repeat(5);
    const text = join(TOKEN, ' then https://app:', PASSWORD, '@queue.local and -H "Authorization: Bearer ', header, '"');
    assert.deepEqual(shapes.hitsIn(text), [
      { id: 'github-token', description: 'GitHub token', value: TOKEN },
      { id: 'url-credentials', description: 'credentials in a URL', value: PASSWORD },
      { id: 'auth-header', description: 'credentials in an Authorization header', value: header },
    ]);
  });

  it('yields every match, a repeated one too', () => {
    const text = join('https://a:', PASSWORD, '@one and amqp://b:', PASSWORD, '@two');
    assert.deepEqual(
      shapes.hitsIn(text).map(({ value }) => value),
      [PASSWORD, PASSWORD],
    );
  });

  it('skips a placeholder in a framing shape', () => {
    for (const text of ['https://user:<pass>@host', 'https://u:p@host', 'https://u:changeme@host', 'https://u:*****@host', 'https://u:${PASS}@host']) {
      assert.deepEqual(shapes.hitsIn(text), [], text);
    }
  });

  it('lets a prose assignment through', () => {
    assert.deepEqual(shapes.hitsIn(join('the db pass', 'word: ', 'hunter22', ' is in the vault runbook')), []);
  });

  it('adds the configured patterns, case-insensitively', () => {
    const configured = join('TOK', '_ABCD1234');
    assert.deepEqual(shapes.hitsIn(configured), [{ id: 'config-1', description: 'secret pattern from the team config', value: configured }]);
    assert.deepEqual(new SecretShapes().hitsIn(configured), []);
  });
});

describe('isPlaceholderValue', () => {
  it('judges a short word or a stand-in a placeholder, a real value not', () => {
    for (const value of ['p', 'short', '<pass>', '${PASS}', '*****', 'changeme', 'redacted']) assert.equal(isPlaceholderValue(value), true, value);
    assert.equal(isPlaceholderValue(PASSWORD), false);
  });
});
