import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TempRepo } from '../lib/temp-repo.ts';

const CLI = fileURLToPath(new URL('./release-merge-cli.ts', import.meta.url));

describe('release merge CLI', () => {
  let repo: TempRepo;
  let output: string;
  let summary: string;

  beforeEach(() => {
    repo = new TempRepo('release-merge').init();
    output = join(repo.outside, 'output');
    summary = join(repo.outside, 'summary');
    writeFileSync(output, '');
    writeFileSync(summary, '');
  });

  afterEach(() => repo.remove());

  const gateEnv = (over: Readonly<Record<string, string | undefined>> = {}) => ({
    GITHUB_REPOSITORY: 'teamrig/teamrig',
    RUN_ID: '7',
    GITHUB_TOKEN: 'read-token',
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    // A closed port, so the first read fails at once and the gate refuses without leaving the machine.
    GITHUB_API_URL: 'http://127.0.0.1:9',
    ...over,
  });

  it('takes gate or merge and nothing else', () => {
    for (const args of [[], ['publish'], ['gate', 'extra']]) {
      const run = repo.run(CLI, args);
      assert.equal(run.status, 2, run.stderr);
      assert.match(run.stderr, /takes one argument: gate or merge/);
    }
  });

  it('exits 2 naming a value that is missing or malformed, before reading GitHub', () => {
    const missing = repo.run(CLI, ['gate'], gateEnv({ GITHUB_TOKEN: undefined }));
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /GITHUB_TOKEN is not set/);
    const malformed = repo.run(CLI, ['gate'], gateEnv({ RUN_ID: '7; echo' }));
    assert.equal(malformed.status, 2);
    assert.match(malformed.stderr, /RUN_ID is not in the form/);
    assert.equal(readFileSync(output, 'utf8'), '');
  });

  it('refuses with exit 1 when GitHub cannot be read, writing pass=false and the reason to the summary', () => {
    const run = repo.run(CLI, ['gate'], gateEnv());
    assert.equal(run.status, 1, run.stderr);
    assert.equal(readFileSync(output, 'utf8'), 'pass=false\n');
    assert.match(readFileSync(summary, 'utf8'), /^Release merge gate refused: the gate could not finish: /);
  });

  it('refuses a merge whose sha is not a full commit id, before any key is used', () => {
    const run = repo.run(CLI, ['merge'], {
      GITHUB_REPOSITORY: 'teamrig/teamrig',
      PR: '12',
      SHA: 'abc',
      CHECKS: '3',
      PATHS: 'CHANGELOG.md',
      RUN_URL: 'https://github.com/teamrig/teamrig/actions/runs/8',
      APP_ID: '42',
      APP_KEY: 'not a key',
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /SHA is not in the form/);
    assert.doesNotMatch(run.stderr, /not a key/);
  });
});
