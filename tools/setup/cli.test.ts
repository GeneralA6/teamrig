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

  it('refuses a usage it does not know with exit 2', () => {
    repo.init();
    const result = repo.run(CLI, ['--chek']);
    assert.equal(result.status, 2);
    assert.equal(result.stderr.trimEnd(), 'setup: unknown arguments: --chek (usage: cli.ts [--check])');
    assert.equal(repo.git('config', '--local', '--default', 'unset', '--get', 'core.hooksPath').trim(), 'unset');
  });
});

describe('setup cli --check', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo('setup-check');
  });
  afterEach(() => repo.remove());

  it('fails a clone that never ran setup and says how to fix it, changing nothing', () => {
    repo.init();
    const result = repo.run(CLI, ['--check']);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      result.stdout.trimEnd(),
      `git hooks: core.hooksPath is not set, not ${HOOKS_PATH}, so commits and pushes skip the scrub, sign-off and local gate; run \`npm run setup\``,
    );
    assert.equal(repo.git('config', '--local', '--default', 'unset', '--get', 'core.hooksPath').trim(), 'unset');
  });

  it('fails a clone whose global core.hooksPath runs other hooks in place of the repo ones', () => {
    repo.init();
    repo.git('config', '--global', 'core.hooksPath', 'global-hooks');
    const result = repo.run(CLI, ['--check']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^git hooks: core\.hooksPath is global-hooks, not \.githooks, /);
  });

  it('passes once setup ran', () => {
    repo.init();
    assert.equal(repo.run(CLI).status, 0);
    const result = repo.run(CLI, ['--check']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trimEnd(), `git hooks: core.hooksPath = ${HOOKS_PATH}`);
  });

  it('passes outside a git checkout, where there are no hooks to run', () => {
    const result = repo.run(CLI, ['--check']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trimEnd(), 'git hooks: not a git checkout, skipped');
  });
});
