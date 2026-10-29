import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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

/** jwt.io's HS256 sample, signed at run time with the key the site prints, so its shape never sits in the source. */
function jwtSample(payload: string, key: string): string {
  const body = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(payload).toString('base64url')}`;
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

describe('isPlaceholderValue', () => {
  it('judges a short word, a reference, a masked value and a stand-in word a placeholder', () => {
    const placeholders = ['p', 'short', '<db_password>', '${PASS}', '$PASS', '$(cat key)', '%PASS%', '{password}', '[token]', '*****', 'ab***yz', 'xxxxxxxx', '00000000'];
    for (const value of [...placeholders, 'changeme', 'redacted', 'Password', 'placeholder', 'your_api_key', 'put-key-here']) {
      assert.equal(isPlaceholderValue(value), true, value);
    }
  });

  it('judges the value alone: a symbol inside or a percent-encoded start is still a secret', () => {
    for (const value of [PASSWORD, join('pa$$', 'w0rd', '99'), join('Xy7', '<kq>', 'z9!'), join('%40', 'bc12', '3xyz'), join('example', 'Pass', '42')]) {
      assert.equal(isPlaceholderValue(value), false, value);
    }
  });
});

describe('SecretShapes value judge', () => {
  const shapes = new SecretShapes();

  it('finds a real password whatever the host: localhost and a host named example are no excuse', () => {
    for (const host of ['127.0.0.1', 'localhost:5432', 'db.example.com']) {
      assert.deepEqual(
        shapes.hitsIn(join('postgres://admin:', PASSWORD, '@', host, '/app')).map(({ value }) => value),
        [PASSWORD],
        host,
      );
    }
  });

  it('lets the jwt.io samples through, bare or in a header, and finds any other token', () => {
    const samples = [
      jwtSample('{"sub":"1234567890","name":"John Doe","iat":1516239022}', 'your-256-bit-secret'),
      jwtSample('{"sub":"1234567890","name":"John Doe","admin":true,"iat":1516239022}', 'a-string-secret-at-least-256-bits-long'),
    ];
    for (const sample of samples) {
      assert.deepEqual(shapes.hitsIn(sample), []);
      assert.deepEqual(shapes.hitsIn(join('Authorization: Bearer ', sample)), []);
      assert.equal(isPlaceholderValue(sample), true);
    }
    const other = jwtSample('{"sub":"42","iat":1516239022}', 'k3y-of-our-own');
    assert.deepEqual(
      shapes.hitsIn(other).map(({ id }) => id),
      ['jwt'],
    );
  });
});
