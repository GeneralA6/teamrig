import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EnvAssignments } from './env-assignments.ts';
import { DEFAULT_SECRET_ENV_NAMES, SecretNames } from './names.ts';

const join = (...parts: string[]): string => parts.join('');
const PASSWORD = join('s3', 'cret', 'Value9');
const KEY = join('Qx7mRt', '_Lp4wZn');
const assignments = new EnvAssignments(new SecretNames(DEFAULT_SECRET_ENV_NAMES));
const values = (finder: EnvAssignments, text: string): string[] => finder.hitsIn(text).map(({ value }) => value);

describe('EnvAssignments', () => {
  it('finds the value of each secret variable an environment dump prints', () => {
    const dump = join('HOME=/c/u\nDB_PASS', 'WORD=', PASSWORD, '\nNODE_ENV=production\nOPENAI_API_', 'KEY=', KEY, '\n');
    assert.deepEqual(assignments.hitsIn(dump), [
      { id: 'env-assignment', description: 'value of a secret variable', value: PASSWORD },
      { id: 'env-assignment', description: 'value of a secret variable', value: KEY },
    ]);
  });

  it('stops the value at a quote or a shell operator, as docker inspect and a command line frame it', () => {
    assert.deepEqual(values(assignments, join('"Env": ["DB_PASS', 'WORD=', PASSWORD, '", "PORT=8080"]')), [PASSWORD]);
    assert.deepEqual(values(assignments, join('export API_', 'KEY=', KEY, '; npm start')), [KEY]);
  });

  it('passes source code, which spaces the assignment or names a lower-case variable', () => {
    for (const text of [join('const token = ', KEY), 'token: string', join('api_', 'key=', KEY), join('$API_', 'KEY=', KEY)]) {
      assert.deepEqual(values(assignments, text), [], text);
    }
  });

  it('passes a value that only names, points to or counts a secret', () => {
    const plain = [
      'TOKEN_LIMIT=200000',
      'KEY_FILE=/a/b.pem',
      'KEY_FILE=C:\\k\\b.pem',
      'TOKEN=$(gh auth token)',
      'TOKEN=SOME_READ_TOKEN',
      'GITHUB_TOKEN=***',
      'TOKEN_TYPE=bearer',
      'DB_PASSWORD=${DB_PASSWORD}',
    ];
    assert.deepEqual(plain.filter((text) => assignments.hitsIn(text).length > 0), []);
  });

  it('passes one Title-case word, a role or a mode, as it passes the lower-case word', () => {
    // A live pod env listing (T2399): Grafana's anonymous role setting holds a role name. Built from parts so no line
    // of this file holds the name and its value together.
    const roleSetting = join('GF_AUTH_ANONYMOUS_', 'ORG_ROLE');
    for (const role of ['Viewer', 'Admin', 'Editor', 'Basic']) {
      assert.deepEqual(values(assignments, join(roleSetting, '=', role, '\n')), [], role);
    }
  });

  it('still finds a capitalised value that is more than one plain word', () => {
    const roleSetting = join('GF_AUTH_ANONYMOUS_', 'ORG_ROLE');
    for (const value of [join('Sum', 'mer24'), join('Qx7m', 'Rt9w'), join('Sum', 'mer.')]) {
      assert.deepEqual(values(assignments, join(roleSetting, '=', value, '\n')), [value], value);
    }
  });

  it("judges a URL by its login, password, secret-named parameters and token-shaped path segments, and keeps the whole URL", () => {
    const hook = join('Qx7mRt9w', 'Lp4wZn2kV8');
    const urls = [
      join('DB_URL=db://app:', PASSWORD, '@db.example.net:5432/app'),
      join('DB_URL=https://', KEY, '@git.example.com/o/r.git'),
      join('DB_URL=https://api.example.com/v1/items?page=2&access_', 'token=', KEY, '&sort=asc'),
      join('DB_URL=https://app.example.com/callback#state=s1&access_', 'token=', KEY),
      join('SLACK_WEBHOOK_URL=https://hooks.example.com/services/T0A1B2C3/', hook),
    ];
    for (const assignment of urls) {
      assert.deepEqual(values(assignments, join(assignment, ' more')), [assignment.slice(assignment.indexOf('=') + 1)], assignment);
    }
  });

  it('passes a URL with no login, password or secret in its parameters or path, as a connection string with a certificate file', () => {
    const plain = [
      'DB_URL=db+srv://cluster0.ab12c.example.net/?authMechanism=GSSAPI&authSource=$external&tls=true&tlsCertificateKeyFile=pem',
      'DB_URL=db://db.example.net:5432/app_2024?sslmode=require',
      join('DB_URL=db://app', '@db.example.net/app'),
      'CACHE_URL=cache://kv.local:6379/0',
      'DB_URL=https://api.example.com/v2/user-profile-settings-v2',
      'DB_URL=https://x.example.com/?token=${TOKEN}&password=<password>',
      join('DB_URL=https://api.example.com/items?cursor=', KEY),
    ];
    assert.deepEqual(plain.filter((text) => assignments.hitsIn(text).length > 0), []);
  });

  it('passes the setting a git config key names, and still reads a URL or a token there (T2001)', () => {
    const name = join('GIT_CONFIG_', 'KEY_12=');
    const settings = ['core.hooksPath', 'http.extraHeader', 'branch.feature/x.remote', join('http.https', '://host.example/.extraHeader')];
    assert.deepEqual(settings.filter((setting) => assignments.hitsIn(join(name, setting)).length > 0), []);
    const insteadOf = join('url.https', '://', KEY, '@host.example/.insteadOf');
    assert.deepEqual(values(assignments, join(name, insteadOf)), [insteadOf]);
    assert.deepEqual(values(assignments, join(name, KEY)), [KEY]);
    const dotted = join('9', KEY, '.x');
    assert.deepEqual(values(assignments, join(name, dotted)), [dotted]);
  });

  it("keeps that reading to git's own variable (T2001)", () => {
    const setting = 'core.hooksPath';
    const names = [join('API_', 'KEY='), join('GIT_CONFIG_', 'KEY='), join('MY_GIT_CONFIG_', 'KEY_0='), join('GIT_CONFIG_', 'KEY_0_TOKEN=')];
    assert.deepEqual(names.map((name) => values(assignments, join(name, setting))), names.map(() => [setting]));
  });

  it('passes a variable whose name is not a secret one', () => {
    assert.deepEqual(values(assignments, join('HOME=/c/u\nBUILD_ID=', KEY)), []);
  });

  it("takes a team's own name, and keeps one printable with a later !pattern", () => {
    const team = new EnvAssignments(new SecretNames([...DEFAULT_SECRET_ENV_NAMES, '^STRIPE_', '!^TOKENIZERS_']));
    assert.deepEqual(values(team, join('STRIPE_LIVE=', KEY)), [KEY]);
    assert.deepEqual(values(team, join('TOKENIZERS_CACHE=', KEY)), []);
    assert.deepEqual(values(assignments, join('STRIPE_LIVE=', KEY)), []);
  });
});
