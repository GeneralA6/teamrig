import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SECRET_TEXT_PATTERNS, SECRET_TOKEN_PATTERNS } from './secret-patterns.ts';

/** Secret-shaped strings are assembled at runtime so none sits in the source for the scrub to flag. */
const join = (...parts: string[]): string => parts.join('');
const ALL = [...SECRET_TOKEN_PATTERNS, ...SECRET_TEXT_PATTERNS];
/** The ids of every pattern `text` matches. */
const ids = (text: string): string[] => ALL.filter(({ pattern }) => pattern.test(text)).map(({ id }) => id);

/** Each pattern with texts it must match and near misses it must let through. */
const CASES: ReadonlyArray<{ readonly id: string; readonly hits: readonly string[]; readonly misses: readonly string[] }> = [
  {
    id: 'private-key',
    hits: [join('-----BEGIN ', 'RSA PRIVATE KEY-----'), join('-----BEGIN ', 'PRIVATE KEY-----'), join('-----BEGIN ', 'OPENSSH PRIVATE KEY-----'), join('-----BEGIN ', 'PGP PRIVATE KEY BLOCK-----')],
    misses: [join('-----BEGIN ', 'PUBLIC KEY-----'), join('-----BEGIN ', 'CERTIFICATE-----'), 'paste the private key into the vault'],
  },
  {
    id: 'github-token',
    hits: ['ghp', 'gho', 'ghs', 'ghu', 'ghr'].map((prefix) => join(prefix, '_', 'a1'.repeat(18))).concat(join('github', '_pat_', 'B2_'.repeat(14))),
    misses: [join('ghp', '_', 'a'.repeat(20)), join('ghx', '_', 'a'.repeat(36)), 'the ghp_ prefix marks a personal token', join('github', '_pat_', 'short')],
  },
  {
    id: 'anthropic-key',
    hits: [join('sk-', 'ant-', 'api03-', 'c'.repeat(40))],
    misses: [join('sk-', 'ant-', 'short'), 'keys start with sk-ant-'],
  },
  {
    id: 'sk-key',
    hits: [join('sk-', 'd4'.repeat(24)), join('sk-', 'proj-', 'Ab_9-'.repeat(10)), join('sk-', 'svcacct-', 'e5'.repeat(20))],
    misses: ['skeleton', 'we use sk-learn here', join('sk-', 'learn-compatible-pipeline-transformers'), join('task-', 'f6'.repeat(20)), join('sk-', 'g7'.repeat(10))],
  },
  {
    id: 'aws-key',
    hits: [join('AKIA', 'ABCDEFGH12345678'), join('ASIA', 'ABCDEFGH12345678')],
    misses: [join('AKIA', 'ABCDEFGH1234567'), join('akia', 'abcdefgh12345678'), 'access keys start with AKIA', join('XAKIA', 'ABCDEFGH12345678')],
  },
  {
    id: 'slack-token',
    hits: [join('xoxb', '-', '1'.repeat(12), '-abc'), join('xoxp', '-', '2345-6789-abcdef')],
    misses: [join('xoxb', '-', 'not-a-real-token'), join('xoxz', '-', '1'.repeat(12)), join('xoxb', '-', '123')],
  },
  {
    id: 'google-key',
    hits: [join('AIza', 'Sy', 'e'.repeat(33))],
    misses: [join('AIza', 'e'.repeat(34)), join('AIza', 'e'.repeat(36)), 'browser keys start with AIza'],
  },
  {
    id: 'stripe-key',
    hits: [join('sk', '_live_', 'h8'.repeat(12)), join('rk', '_live_', 'H9'.repeat(14))],
    misses: [join('sk', '_test_', 'h8'.repeat(12)), join('sk', '_live_', 'short'), join('pk', '_live_', 'h8'.repeat(12))],
  },
  {
    id: 'jwt',
    hits: [join('eyJ', 'hbGciOiJIUzI1NiJ9', '.eyJ', 'zdWIiOiIxMjM0In0', '.', 'sig_nature-1')],
    misses: [join('eyJ', 'hbGciOiJIUzI1NiJ9', '.eyJ', 'zdWIiOiIxMjM0In0'), 'eyJ is the start of base64 JSON', join('abc', 'defghijk', '.eyJ', 'zdWIiOiIxMjM0In0', '.', 'signature')],
  },
  {
    id: 'url-credentials',
    hits: [join('amqp://', 'app', ':', 's3cret', '@', 'queue.local:5672'), join('HTTPS://', 'u', ':', 'p', '@', 'host')],
    misses: ['https://example.test/path?a=1', 'mail me at someone@example.com', 'ssh://git@github.com/o/r'],
  },
  {
    id: 'secret-assignment',
    hits: [
      join('PASS', 'WORD', '=', 'abc'),
      join('api', '_key', ': ', 'xyz'),
      join('secret', ' = ', 'x'),
      join('jwt.', 'secret', ': ', 'abc'),
      join('X-Api-', 'Key', ': ', 'abc'),
      join('https://host/reset?', 'secret', '=', 'abc'),
      join('src/run.ts --', 'pass', 'word', '=', 'abc'),
    ],
    misses: [
      'rotate the password via the vault runbook',
      'the secret is kept in the vault',
      'password=',
      join('merged feat/t533-jwt-previous-', 'secret', ': pushed'),
      join('.worktrees/t550-api-', 'key', ': removed'),
    ],
  },
];

describe('secret patterns', () => {
  it('has one case set per pattern, with unique ids and no g flag', () => {
    assert.deepEqual(
      CASES.map(({ id }) => id),
      ALL.map(({ id }) => id),
    );
    assert.equal(new Set(ALL.map(({ id }) => id)).size, ALL.length);
    for (const { id, pattern, description } of ALL) {
      assert.equal(pattern.flags.includes('g'), false, id);
      assert.notEqual(description, '', id);
    }
  });

  for (const { id, hits, misses } of CASES) {
    it(`${id}: matches its shape and lets near misses through`, () => {
      for (const hit of hits) {
        assert.ok(ids(hit).includes(id), `${id} should match a ${hit.length}-character case`);
      }
      for (const miss of misses) {
        assert.equal(ids(miss).includes(id), false, `${id} should not match: ${miss.slice(0, 12)}`);
      }
    });
  }

  it('lets commit shas, ids and ordinary prose through every pattern', () => {
    const clean = ['3f9a1c0e7b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a', '83b3049', 'T249 push guard', 'the skeleton key opens nothing', 'ask before a push to main'];
    for (const text of clean) {
      assert.deepEqual(ids(text), [], text);
    }
  });
});
