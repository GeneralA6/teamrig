import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { TempRepo } from '../lib/temp-repo.ts';
import { DENYLIST_CONFIG_KEY } from '../scrub/run.ts';
import { HOOKS_PATH } from './hooks.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

describe('setup cli', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo('setup');
  });
  afterEach(() => repo.remove());

  it('points the clone at the repo hooks and says how to add the optional denylist', () => {
    repo.init();
    const result = repo.run(CLI);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split(/\r?\n/), [
      `git hooks: core.hooksPath = ${HOOKS_PATH}`,
      `private denylist: not configured (optional): git config --local ${DENYLIST_CONFIG_KEY} <path>`,
    ]);
    assert.equal(repo.git('config', '--local', 'core.hooksPath').trim(), HOOKS_PATH);
  });

  it('reports the configured denylist', () => {
    repo.init();
    repo.git('config', '--local', DENYLIST_CONFIG_KEY, 'private/deny.txt');
    const result = repo.run(CLI);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^private denylist: private\/deny\.txt$/m);
  });

  it('skips with exit 0 outside a git checkout, so npm install of a tarball still works', () => {
    const result = repo.run(CLI);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trimEnd(), 'git hooks: not a git checkout, skipped');
  });

  it('skips with exit 0 when git is not on the PATH', () => {
    repo.init();
    const result = repo.run(CLI, [], { PATH: repo.outside });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trimEnd(), 'git hooks: not a git checkout, skipped');
    assert.equal(repo.git('config', '--local', '--default', 'unset', '--get', 'core.hooksPath').trim(), 'unset');
  });
});
