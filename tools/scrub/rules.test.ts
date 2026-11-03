import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WRITE_TIME_SHAPES } from '../../src/core/secret-shapes.ts';
import { GENERIC_RULES } from './rules.ts';
import { scanText } from './scan.ts';

// Fixtures are assembled at runtime so this file never holds a literal the scrub would flag.
const join = (...parts: string[]): string => parts.join('');
const ruleIds = (text: string): string[] => scanText('fixture', text, GENERIC_RULES).map((finding) => finding.ruleId);
const BACKSLASH = '\\';

describe('generic scrub rules', () => {
  it('flags absolute paths inside a user home on Windows, macOS and Linux', () => {
    assert.deepEqual(ruleIds(join('C:', BACKSLASH, 'Users', BACKSLASH, 'dana', BACKSLASH, 'repo')), ['home-path']);
    assert.deepEqual(ruleIds(join('D:/', 'Users/dana/repo')), ['home-path']);
    assert.deepEqual(ruleIds(join('open /', 'home/dana/x and /', 'Users/dana/y')), ['home-path', 'home-path']);
  });

  it('accepts placeholder users and home-relative paths', () => {
    const text = join('C:', BACKSLASH, 'Users', BACKSLASH, '<you> ~/x $HOME/x /', 'home/user/x /', 'Users/you/x');
    assert.deepEqual(ruleIds(text), []);
  });

  it('flags e-mail addresses', () => {
    assert.deepEqual(ruleIds(join('mail dana', '@', 'acme.io today')), ['email']);
  });

  it('accepts documentation, noreply and SSH remote addresses and package specs', () => {
    const text = [
      join('a', '@', 'example.com'),
      join('b', '@', 'sub.example.org'),
      join('noreply', '@', 'anthropic.com'),
      join('1+dana', '@', 'users.noreply.github.com'),
      join('noreply', '@', 'github.com'),
      join('git', '@', 'github.com:owner/repo.git'),
      join('typescript', '@', '5.9.3'),
      '@types/node',
    ].join(' ');
    assert.deepEqual(ruleIds(text), []);
  });

  it('flags IPv4 addresses outside loopback and documentation ranges', () => {
    assert.deepEqual(ruleIds(['10', '1', '2', '3'].join('.')), ['ipv4']);
  });

  it('accepts loopback, documentation ranges and dotted version strings', () => {
    const text = [
      ['127', '0', '0', '1'],
      ['0', '0', '0', '0'],
      ['192', '0', '2', '10'],
      ['198', '51', '100', '7'],
      ['203', '0', '113', '9'],
      ['v1', '2', '3', '4'],
      ['1', '2', '3', '4', '5'],
    ]
      .map((parts) => parts.join('.'))
      .join(' ');
    assert.deepEqual(ruleIds(text), []);
  });

  it('flags internal host names', () => {
    assert.deepEqual(ruleIds(join('db.', 'internal')), ['internal-host']);
  });

  it('flags common secret formats', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['private-key', join('-----BEGIN ', 'RSA PRIVATE KEY-----')],
      ['github-token', join('ghp', '_', 'a'.repeat(36))],
      ['github-token', join('github', '_pat_', 'b'.repeat(50))],
      ['anthropic-key', join('sk-', 'ant-', 'c'.repeat(40))],
      ['sk-key', join('sk-', 'd4'.repeat(20))],
      ['aws-key', join('AKIA', 'ABCDEFGHIJKLMNOP')],
      ['slack-token', join('xoxb', '-', '1'.repeat(12))],
      ['google-key', join('AIza', 'e'.repeat(35))],
      ['stripe-key', join('sk', '_live_', 'j5'.repeat(12))],
      ['jwt', join('eyJ', 'f'.repeat(10), '.eyJ', 'g'.repeat(10), '.', 'h'.repeat(10))],
      ['assigned-secret', join('password', ': "', 'i9'.repeat(8), '"')],
      ['assigned-secret', join('DB_', 'PASSWORD', ' = "', 'k8'.repeat(8), '"')],
      ['assigned-secret', join('client', 'Secret', ": '", 'm7'.repeat(8), "'")],
      ['assigned-secret', join('GITHUB_', 'TOKEN', '="', 'n6'.repeat(8), '"')],
    ];
    for (const [rule, text] of cases) {
      assert.deepEqual(ruleIds(text), [rule], rule);
    }
  });

  it('takes every shape of the write-time set, unrevealed, a framing one with a judge', () => {
    for (const shared of WRITE_TIME_SHAPES) {
      const rule = GENERIC_RULES.find((candidate) => candidate.id === shared.id);
      assert.equal(rule?.pattern, shared.pattern, shared.id);
      assert.equal(rule?.revealMatch, false, shared.id);
      assert.equal(rule?.isAllowed !== undefined, shared.secretGroup !== undefined, shared.id);
    }
  });

  it('flags a credential in a URL, an Authorization header or an API key header, whatever the host', () => {
    // An example host proves the value alone is judged (T1099 gap 1); it also keeps the e-mail rule out of the URL cases.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['url-credentials', join('https://', 'deploy', ':', 'Qx7mRt9Lp4', '@', 'db.example.net/app')],
      ['url-login-token', join('https://', 'Qx7mRt9Lp4wZn', ':x-oauth', '-basic', '@', 'example.com/o/r')],
      ['auth-header', join('Authorization', ': Bearer ', 'Qx7mRt9Lp4wZn')],
      ['api-key-header', join('x-api', '-key: ', 'Qx7mRt9Lp4wZn')],
    ];
    for (const [rule, text] of cases) {
      assert.deepEqual(ruleIds(text), [rule], rule);
    }
  });

  it('accepts a URL whose password is short, refers to a secret kept elsewhere or is masked', () => {
    // A host without a dot keeps the e-mail rule out: `p@` and `%DB_PASSWORD%@` read as an address's start.
    for (const value of ['p', '${DB_PASSWORD}', '<password>', '%DB_PASSWORD%', '********']) {
      assert.deepEqual(ruleIds(join('postgres://', 'app', ':', value, '@', 'localhost:5432/app')), [], value);
    }
  });

  it('accepts a secret-like name bound to a placeholder, judged as the write-time set judges it', () => {
    for (const value of ['${user_config.TOKEN}', '<your-api-token>', '%DB_PASSWORD%', 'xxxxxxxxxxxxxxxx', 'your_api_key_goes_in_env']) {
      assert.deepEqual(ruleIds(join('token', ': "', value, '"')), [], value);
    }
  });

  it("accepts a secret-like name bound to an identifier's name, and refuses a mixed-case value", () => {
    for (const name of ['SOME_READ_TOKEN', 'app-api-secrets', 'v2.prod.signing']) {
      assert.deepEqual(ruleIds(join('secret', ': "', name, '"')), [], name);
    }
    assert.deepEqual(ruleIds(join('secret', ': "', 'Qx7mRt', '_Lp4wZn', '"')), ['assigned-secret']);
  });

  it('refuses a percent-encoded password that only starts with a percent sign', () => {
    assert.deepEqual(ruleIds(join('pass', 'word', ': "', '%40bc', '123xyz9', '"')), ['assigned-secret']);
  });

  it('accepts a secret-like name bound to words with spaces, as no credential has', () => {
    assert.deepEqual(ruleIds(join('API_', 'TOKEN', ': "', 'commit push deploy secret value', '"')), []);
  });

  it('accepts a claim token bound to a uuid, judged as the write-time set judges it, and refuses that uuid under a bare token', () => {
    const uuid = join('3f9a8b7c', '-1d2e-4f5a-8b6c-', '0123456789ab');
    assert.deepEqual(ruleIds(join('claim', 'Token', ': "', uuid, '"')), []);
    assert.deepEqual(ruleIds(join('token', ': "', uuid, '"')), ['assigned-secret']);
  });

  it('fails closed on a match without its captured part: no allow check accepts it', () => {
    const bare = /x/.exec('x');
    assert.ok(bare !== null);
    const framing = WRITE_TIME_SHAPES.filter(({ secretGroup }) => secretGroup !== undefined).map(({ id }) => id);
    for (const id of ['home-path', 'email', ...framing]) {
      const isAllowed = GENERIC_RULES.find((rule) => rule.id === id)?.isAllowed;
      assert.ok(isAllowed !== undefined, id);
      assert.equal(isAllowed(bare), false, id);
    }
  });
});
