import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TempRepo } from '../lib/temp-repo.ts';
import { MANIFEST } from './target.ts';

const CLI = fileURLToPath(new URL('./version-cli.ts', import.meta.url));

describe('release version CLI', () => {
  let repo: TempRepo;
  let head: string;

  beforeEach(() => {
    repo = new TempRepo('release-version').init();
    repo.write(MANIFEST, JSON.stringify({ name: 'teamrig', version: '0.447.1' }));
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'one');
    head = repo.git('rev-parse', 'HEAD').trim();
  });

  afterEach(() => repo.remove());

  it("prints the checked-out commit and its plugin.json version as step outputs", () => {
    const run = repo.run(CLI, []);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, `version=0.447.1\nsha=${head}\n`);
  });

  it('takes an empty --expect as a run by hand, and refuses a version the release did not cut', () => {
    assert.equal(repo.run(CLI, ['--expect', '']).status, 0);
    const refused = repo.run(CLI, ['--expect', '0.448.0']);
    assert.notEqual(refused.status, 0);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /holds 0\.447\.1, but the release is 0\.448\.0/);
  });
});
