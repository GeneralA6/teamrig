import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { TempRepo } from '../lib/temp-repo.ts';

const CLI = fileURLToPath(new URL('./every-check-cli.ts', import.meta.url));
const RUN_ENV = { GITHUB_REPOSITORY: 'acme/web', GITHUB_RUN_ID: '43' };

describe('every-check cli', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo('every-check');
  });
  afterEach(() => repo.remove());

  it('exits 2 with its usage when no job name is given', () => {
    const result = repo.run(CLI, [], RUN_ENV);
    assert.equal(result.status, 2);
    assert.equal(result.stderr.trimEnd(), 'every-check: usage: every-check-cli.ts <the name of the job running it>');
  });

  it('exits 2 outside a GitHub Actions run', () => {
    const result = repo.run(CLI, ['every check passed'], { GITHUB_REPOSITORY: undefined, GITHUB_RUN_ID: undefined });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^every-check: needs GITHUB_REPOSITORY/m);
  });

  it('fails the check, never passes it, when the jobs cannot be listed', () => {
    const result = repo.run(CLI, ['every check passed'], { ...RUN_ENV, PATH: repo.outside });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^every-check: .*\bgh\b.*ENOENT/m);
  });
});
