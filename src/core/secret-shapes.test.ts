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
  it('holds every token shape, the framed text shapes and the literal ones, not the prose assignment', () => {
    const ids = WRITE_TIME_SHAPES.map(({ id }) => id);
    for (const { id } of SECRET_TOKEN_PATTERNS) assert.ok(ids.includes(id), id);
    for (const id of ['url-credentials', 'auth-header', 'api-key-header', 'assigned-secret']) assert.ok(ids.includes(id), id);
    assert.equal(ids.includes('secret-assignment'), false);
  });
});

describe('SecretShapes literal shapes', () => {
  const shapes = new SecretShapes();
  const KEY = join('k3Y', 'q8'.repeat(8));
  const found = (text: string): Array<{ id: string; value: string }> => shapes.hitsIn(text).map(({ id, value }) => ({ id, value }));

  it('finds an API key header value, any x- spelling, quoted or not', () => {
    for (const text of [join('curl -H "x-api-key: ', KEY, '" https://x'), join("-H 'X-Goog-Api-Key: ", KEY, "'"), join('api-key: ', KEY)]) {
      assert.deepEqual(found(text), [{ id: 'api-key-header', value: KEY }], text);
    }
  });

  it('lets an API key header through when it names a reference, a short word or no key', () => {
    for (const text of ['curl -H "x-api-key: $API_KEY" https://x', 'x-api-key: <your-key>', 'x-api-key: ${KEY}', 'set the x-api-key: header on each call', 'x-api-key: documentation']) {
      assert.deepEqual(found(text), [], text);
    }
  });

  it('finds a quoted literal given to a secret-like name, and lets a reference or a spaced phrase through', () => {
    assert.deepEqual(found(join('DB_PASS', 'WORD="', KEY, '"')), [{ id: 'assigned-secret', value: KEY }]);
    for (const text of [join('DB_PASS', 'WORD="${DB_PASSWORD}"'), join('api_', 'token: "', 'not a secret at all', '"'), join('pass', 'word: ', KEY)]) {
      assert.deepEqual(found(text), [], text);
    }
  });

  it("lets an identifier's name given to a secret-like key through: it names the secret", () => {
    for (const name of ['SOME_READ_TOKEN', 'app-api-secrets', 'prod_db_password', 'GH_APP_KEY2_FOR_CI', 'v2.prod.signing', 'release-2026-10']) {
      assert.deepEqual(found(join('TOK', 'EN="', name, '"')), [], name);
    }
  });

  it('finds a mixed-case, digit-inside or one-word value given to a secret-like key', () => {
    for (const value of [join('Qx7mRt', '_Lp4wZn'), join('3f9a8b7c', '-1d2e-4f5a'), join('SOMEREAD', 'TOKENVALUE')]) {
      assert.deepEqual(found(join('TOK', 'EN="', value, '"')), [{ id: 'assigned-secret', value }], value);
    }
  });

  it("still finds a name-shaped password in a URL: only the assignment shape lets a name through", () => {
    assert.deepEqual(found(join('https://app:', 'SOME_READ_TOKEN', '@queue', '.local')), [{ id: 'url-credentials', value: 'SOME_READ_TOKEN' }]);
  });

  const UUID = join('3f9a8b7c', '-1d2e-4f5a-8b6c-', '0123456789ab');
  /** The same name and value in a JSON frame and a JS one, as a claim record and the code writing it hold them. */
  const frames = (name: string, value: string): string[] => [join('{"', name, '":"', value, '"}'), join('{ ', name, ": '", value, "' }")];

  it('lets a coordination id given to a claim, lock, lease or fencing token through: a uuid, alone or after its holder', () => {
    for (const name of ['claimToken', 'lock_token', 'LEASE_TOKEN', 'fencingToken']) {
      for (const value of [UUID, join('worker-7#', UUID), join('build-host-5d9f', '.local:', UUID)]) {
        for (const text of frames(name, value)) assert.deepEqual(found(text), [], text);
      }
    }
  });

  it('still finds that uuid under any other token or secret name, one only ending in a coordination word too', () => {
    for (const name of ['token', 'apiToken', 'unlockToken', 'nodeClaimToken', 'password']) {
      for (const text of frames(name, UUID)) assert.deepEqual(found(text), [{ id: 'assigned-secret', value: UUID }], text);
    }
  });

  it('still finds a claim token holding anything but a coordination id', () => {
    for (const value of [join('Qx7mRt', '_Lp4wZn9'), join(UUID, 'x')]) {
      for (const text of frames('claimToken', value)) assert.deepEqual(found(text), [{ id: 'assigned-secret', value }], text);
    }
  });
});

describe('SecretShapes', () => {
  const shapes = new SecretShapes(['tok_[a-z0-9]{8}']);

  it('yields a token whole and a framed secret by its group, each with its shape', () => {
    const header = 'q7Wd'.repeat(5);
    const text = join(TOKEN, ' then https://app:', PASSWORD, '@queue.local and -H "Authorization: Bearer ', header, '"');
    assert.deepEqual(shapes.hitsIn(text), [
      { id: 'github-token', description: 'GitHub token', value: TOKEN },
      { id: 'url-credentials', description: 'credentials in a URL', value: PASSWORD, account: 'login app at queue.local' },
      { id: 'auth-header', description: 'credentials in an Authorization header', value: header },
    ]);
  });

  it('finds the password of a URL with an empty login, as a password-only server takes it', () => {
    assert.deepEqual(shapes.hitsIn(join('cache://:', PASSWORD, '@kv.local:6379/0')), [{ id: 'url-credentials', description: 'credentials in a URL', value: PASSWORD, account: 'no login at kv.local' }]);
  });

  it("finds the token a URL gives as its login before GitHub's fixed x-oauth-basic password, and not that word", () => {
    const login = join('Qx7m', 'Rt9w'.repeat(6));
    assert.deepEqual(shapes.hitsIn(join('git clone https://', login, ':x-oauth-', 'basic', '@github.com/o/r.git')), [{ id: 'url-login-token', description: 'credentials in a URL', value: login, account: 'a login at github.com' }]);
    assert.deepEqual(
      shapes.hitsIn(join('https://', TOKEN, ':X-OAuth-', 'Basic', '@github.com/o/r')).map(({ id, value }) => ({ id, value })),
      [
        { id: 'github-token', value: TOKEN },
        { id: 'url-login-token', value: TOKEN },
      ],
    );
    assert.deepEqual(shapes.hitsIn(join('https://<token>:x-oauth-', 'basic', '@github.com/o/r')), []);
  });

  it('finds the password after an x-access-token login: there the password is the token', () => {
    assert.deepEqual(
      shapes.hitsIn(join('https://x-access-', 'token:', PASSWORD, '@github.com/o/r')).map(({ id, value }) => ({ id, value })),
      [{ id: 'url-credentials', value: PASSWORD }],
    );
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

  it("skips an example file's change-me password in any spelling, and still finds a real one of the same length (T1693)", () => {
    for (const word of ['CHANGE_ME', 'change-me', 'changeme']) {
      assert.deepEqual(shapes.hitsIn(join('postgres://app:', word, '@db.local/app')), [], word);
    }
    const real = join('Qx7m', '_Lp4w');
    assert.deepEqual(
      shapes.hitsIn(join('postgres://app:', real, '@db.local/app')).map(({ value }) => value),
      [real],
    );
  });

  it('lets a search for a URL password and a query string built in code through', () => {
    for (const text of ["grep -E 'postgres://[^:]+:[^@]+@' app.log", join("fetch('https://api.local/v1?api_", "key='+process.env.API_KEY+'&q=1')")]) {
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

describe('SecretShapes accounts', () => {
  const shapes = new SecretShapes(['tok_[a-z0-9]{8}']);
  const accountsIn = (text: string): Array<string | undefined> =>
    shapes
      .hitsIn(text)
      .filter(({ id }) => id.startsWith('url-'))
      .map(({ account }) => account);

  it("names a URL's login, a short one too, and its host's last two labels lower-cased, never the port, path or query", () => {
    assert.deepEqual(accountsIn(join('postgres://app:', PASSWORD, '@DB.Prod.Example.COM:5432/app?sslmode=require#top')), ['login app at example.com']);
    assert.deepEqual(accountsIn(join('amqp://u:', PASSWORD, '@localhost/')), ['login u at localhost']);
  });

  it('says an IP address or an unnamed host rather than naming one', () => {
    for (const host of ['127.0.0.1:5432', '[::1]:6379']) {
      assert.deepEqual(accountsIn(join('postgres://app:', PASSWORD, '@', host, '/app')), ['login app at an IP address'], host);
    }
    assert.deepEqual(accountsIn(join('file://app:', PASSWORD, '@/srv/app')), ['login app at an unnamed host']);
  });

  it('writes "a login" for a login that is a token, a configured shape or a stand-in, so no secret reaches a task', () => {
    for (const login of [TOKEN, join('tok_', 'abcd1234'), '<user>', '${USER}', 'username']) {
      assert.deepEqual(accountsIn(join('https://', login, ':', PASSWORD, '@github.com/o/r')), ['a login at github.com'], login);
    }
  });

  it('gives no account to a shape without login and host groups', () => {
    assert.deepEqual(
      shapes.hitsIn(join(TOKEN, ' and Authorization: Bearer ', 'q7Wd'.repeat(5))).map((hit) => 'account' in hit),
      [false, false],
    );
  });
});

/** jwt.io's HS256 sample, signed at run time with the key the site prints, so its shape never sits in the source. */
function jwtSample(payload: string, key: string): string {
  const body = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(payload).toString('base64url')}`;
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

/** RFC 4648 base32 of `text`, unpadded, the form an authenticator reads a TOTP secret in; at run time, so its shape never sits in the source. */
function base32(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...Buffer.from(text)].map((byte) => byte.toString(2).padStart(8, '0')).join('');
  return (bits.match(/.{1,5}/g) ?? []).map((chunk) => alphabet.charAt(parseInt(chunk.padEnd(5, '0'), 2))).join('');
}

describe('isPlaceholderValue', () => {
  it('judges a short word, a reference, a masked value and a stand-in word a placeholder', () => {
    const placeholders = ['p', 'short', '<db_password>', '${PASS}', '$PASS', '$(cat key)', '%PASS%', '{password}', '[token]', '*****', 'ab***yz', 'ab12cd...', 'ab12cd…', 'xxxxxxxx', '00000000'];
    for (const value of [...placeholders, 'changeme', 'CHANGE_ME', 'change-me', 'Change_Me', 'redacted', 'Password', 'placeholder', 'your_api_key', 'put-key-here']) {
      assert.equal(isPlaceholderValue(value), true, value);
    }
  });

  it('judges a regex class and a spliced variable a placeholder: a search or code, not a secret', () => {
    for (const value of [']+:[^', '[^\\s/@]+', 'ab]{8,}', '+process.env.API_KEY+', '+cfg.token+']) {
      assert.equal(isPlaceholderValue(value), true, value);
    }
  });

  it('judges the value alone: a symbol inside or a percent-encoded start is still a secret', () => {
    for (const value of [PASSWORD, join('pa$$', 'w0rd', '99'), join('Xy7', '<kq>', 'z9!'), join('%40', 'bc12', '3xyz'), join('example', 'Pass', '42'), join('+Qx7', '/mRt9+')]) {
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

  it("lets RFC 6238's test secret through under a secret-like name, and finds any other base32 value", () => {
    const assigned = (value: string): string => join('const secret = "', value, '";');
    const sample = base32('12345678901234567890');
    assert.deepEqual(shapes.hitsIn(assigned(sample)), []);
    assert.equal(isPlaceholderValue(sample), true);
    assert.deepEqual(
      shapes.hitsIn(assigned(base32('09876543210987654321'))).map(({ id }) => id),
      ['assigned-secret'],
    );
  });
});
