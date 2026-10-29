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
