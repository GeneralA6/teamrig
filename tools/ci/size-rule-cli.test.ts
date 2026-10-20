import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TempRepo } from '../lib/temp-repo.ts';

const CLI = fileURLToPath(new URL('./size-rule-cli.ts', import.meta.url));

/** Text of `count` lines. */
const linesOf = (count: number): string => 'x\n'.repeat(count);

describe('size-rule cli', () => {
  let repo: TempRepo;
  let mainSha: string;

  /** Commits every change in the work tree; returns the new commit's sha. */
  function commit(message: string): string {
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', message);
    return repo.git('rev-parse', 'HEAD').trim();
  }

  beforeEach(() => {
    repo = new TempRepo('size-rule').init();
    repo.write('src/a.ts', linesOf(1));
    mainSha = commit('first');
    repo.git('branch', '-M', 'main');
    repo.git('checkout', '-q', '-b', 'change');
  });
  afterEach(() => repo.remove());

  it('fails a large commit with no reason line, and passes once its message gives one', () => {
    repo.write('src/big.ts', linesOf(401));
    const big = commit('add big');
    const failed = repo.run(CLI, ['--base', 'main']);
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stdout, new RegExp(`^size-rule: 1 commit\\(s\\) go over 400 changed non-test lines or 15 non-test files .*${big.slice(0, 7)} "add big" \\(401 line\\(s\\), 1 file\\(s\\)\\)`));
    repo.git('commit', '-q', '--amend', '-m', 'add big\n\nLarge-commit: one generated file');
    const passed = repo.run(CLI, ['--base', 'main']);
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /^size-rule: 1 commit\(s\) in main\.\.HEAD, none over 400/);
  });

  it('compares with origin/main by default', () => {
    repo.git('update-ref', 'refs/remotes/origin/main', mainSha);
    repo.write('src/a.ts', linesOf(2));
    commit('small');
    const result = repo.run(CLI);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^size-rule: 1 commit\(s\) in origin\/main\.\.HEAD, none over 400/);
  });

  it("takes a pull request's base and head from the GitHub Actions event with --github", () => {
    repo.write('src/big.ts', linesOf(401));
    const head = commit('add big');
    const event = join(repo.outside, 'event.json');
    writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: mainSha }, head: { sha: head } } }));
    const result = repo.run(CLI, ['--github'], { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_SHA: head });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^size-rule: 1 commit\(s\) go over/);
  });

  it('has nothing to compare for a push that creates a branch', () => {
    const event = join(repo.outside, 'event.json');
    writeFileSync(event, JSON.stringify({ before: '0'.repeat(40), after: mainSha }));
    const result = repo.run(CLI, ['--github'], { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_SHA: mainSha });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'size-rule: no base commit to compare with (a new branch), nothing to check\n');
  });

  it('exits 2 on an unknown option or a base git cannot find', () => {
    const unknown = repo.run(CLI, ['--bogus']);
    assert.equal(unknown.status, 2, unknown.stdout);
    assert.match(unknown.stderr, /^size-rule: Unknown option '--bogus'/);
    const missing = repo.run(CLI, ['--base', 'no-such-branch']);
    assert.equal(missing.status, 2, missing.stdout);
    assert.equal(missing.stderr, 'size-rule: git cannot list the commits in no-such-branch..HEAD\n');
  });
});
