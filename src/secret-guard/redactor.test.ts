import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretShapes } from '../core/secret-shapes.ts';
import { EnvAssignments } from './env-assignments.ts';
import { DEFAULT_SECRET_ENV_NAMES, SecretNames } from './names.ts';
import { MAX_ACCOUNTS, ToolOutputRedactor, type SecretFinder } from './redactor.ts';

const join = (...parts: string[]): string => parts.join('');
const TOKEN = join('gh', 'p_', 'a1'.repeat(18));
const OTHER_TOKEN = join('gh', 'p_', 'b2'.repeat(18));
const PASSWORD = join('s3', 'cret', 'Value9');
const GITHUB = '[redacted GitHub token]';
const VARIABLE = '[redacted value of a secret variable]';
const finders: readonly SecretFinder[] = [new SecretShapes(), new EnvAssignments(new SecretNames(DEFAULT_SECRET_ENV_NAMES))];
const redactor = new ToolOutputRedactor(finders);

describe('ToolOutputRedactor', () => {
  it('replaces a secret in a Bash result, in stdout and stderr alike, and keeps every key and non-string value', () => {
    const response = { stdout: join('token ', TOKEN, '\n'), stderr: join('auth with ', TOKEN, ' failed'), interrupted: false, isImage: false, noOutputExpected: false };
    assert.deepEqual(redactor.redact(response), {
      response: { stdout: join('token ', GITHUB, '\n'), stderr: join('auth with ', GITHUB, ' failed'), interrupted: false, isImage: false, noOutputExpected: false },
      classes: ['GitHub token'],
      accounts: new Map(),
      cut: false,
    });
  });

  it('replaces a value one string held in every other string, where no shape frames it', () => {
    const response = { stdout: join('DB_PASS', 'WORD=', PASSWORD), stderr: join('login refused for ', PASSWORD), interrupted: false, isImage: false };
    const { response: redacted } = redactor.redact(response);
    assert.deepEqual(redacted, { stdout: join('DB_PASS', 'WORD=', VARIABLE), stderr: join('login refused for ', VARIABLE), interrupted: false, isImage: false });
  });

  it("replaces a secret inside a Read result's file content", () => {
    const file = { filePath: 'C:/w/.env', content: join('PORT=8080\nAPI_', 'KEY=', PASSWORD, '\n'), numLines: 2, startLine: 1, totalLines: 2 };
    const { response, classes } = redactor.redact({ type: 'text', file });
    assert.deepEqual(response, { type: 'text', file: { ...file, content: join('PORT=8080\nAPI_', 'KEY=', VARIABLE, '\n') } });
    assert.deepEqual(classes, ['value of a secret variable']);
  });

  it("replaces a secret in a Grep result's content and in each item of its file list", () => {
    const response = { mode: 'content', numFiles: 2, filenames: ['a.env', join('dump-', TOKEN, '.txt')], content: join('a.env:3:GH_', 'TOKEN=', TOKEN), numLines: 1, totalLines: 1 };
    assert.deepEqual(redactor.redact(response).response, {
      ...response,
      filenames: ['a.env', join('dump-', GITHUB, '.txt')],
      content: join('a.env:3:GH_', 'TOKEN=', GITHUB),
    });
  });

  it('replaces the longest value first, so a password inside a found URL leaves no part behind', () => {
    const url = join('postgres://app:', PASSWORD, '@db.local/app');
    const { response, classes } = redactor.redact({ stdout: join('DATABASE_URL=', url, '\nretry with ', PASSWORD) });
    assert.deepEqual(response, { stdout: join('DATABASE_URL=', VARIABLE, '\nretry with [redacted credentials in a URL]') });
    assert.deepEqual([...classes].sort(), ['credentials in a URL', 'value of a secret variable']);
  });

  it("replaces the token a URL gives as its login and keeps GitHub's fixed x-oauth-basic password", () => {
    const login = join('Qx7m', 'Rt9w'.repeat(6));
    assert.deepEqual(redactor.redact({ stdout: join('origin https://', login, ':x-oauth-', 'basic', '@github.com/o/r.git (fetch)') }), {
      response: { stdout: join('origin https://[redacted credentials in a URL]:x-oauth-basic', '@github.com/o/r.git (fetch)') },
      classes: ['credentials in a URL'],
      accounts: new Map([['credentials in a URL', ['a login at github.com']]]),
      cut: false,
    });
  });

  it('names the accounts of each kind once and at most five, under the kind a value was kept as', () => {
    const urls = ['one', 'two', 'one', 'three', 'four', 'five', 'six'].map((host, index) => join('https://app:', PASSWORD, String(index), '@', host, '.local/'));
    const { accounts } = redactor.redact({ stdout: [...urls, join('https://app:', TOKEN, '@github.com/o/r')].join('\n') });
    assert.equal(MAX_ACCOUNTS, 5);
    assert.deepEqual(
      accounts,
      new Map([
        ['credentials in a URL', ['one', 'two', 'three', 'four', 'five'].map((host) => `login app at ${host}.local`)],
        ['GitHub token', ['login app at github.com']],
      ]),
    );
  });

  it('leaves a placeholder and gives back the same result when nothing was found', () => {
    const response = { stdout: 'GITHUB_TOKEN=***\nTOKEN=${TOKEN}\nhttps://user:<password>@host', stderr: '', interrupted: false };
    const redaction = redactor.redact(response);
    assert.equal(redaction.response, response);
    assert.deepEqual(redaction.classes, []);
  });

  it('scans up to the cap: a value past it stays unless it was found before, and the cut is reported', () => {
    const capped = new ToolOutputRedactor(finders, TOKEN.length + 5);
    const { response, cut } = capped.redact({ stdout: TOKEN, stderr: join('more ', TOKEN, ' and ', OTHER_TOKEN) });
    assert.deepEqual(response, { stdout: GITHUB, stderr: join('more ', GITHUB, ' and ', OTHER_TOKEN) });
    assert.equal(cut, true);
    assert.equal(capped.redact({ stdout: 'short' }).cut, false);
  });

  it('keeps the first description a value was found with', () => {
    const first: SecretFinder = { hitsIn: (text) => (text.includes(PASSWORD) ? [{ id: 'one', description: 'first kind', value: PASSWORD }] : []) };
    const second: SecretFinder = { hitsIn: (text) => (text.includes(PASSWORD) ? [{ id: 'two', description: 'second kind', value: PASSWORD }] : []) };
    const { response, classes } = new ToolOutputRedactor([first, second]).redact({ stdout: PASSWORD, count: 3, nested: [{ note: null }] });
    assert.deepEqual(response, { stdout: '[redacted first kind]', count: 3, nested: [{ note: null }] });
    assert.deepEqual(classes, ['first kind']);
  });
});
