import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_USAGE } from '../lib/exit.ts';
import { TempRepo } from '../lib/temp-repo.ts';

const CLI = fileURLToPath(new URL('./commit-subjects-cli.ts', import.meta.url));

describe('commit-subjects cli', () => {
  let repo: TempRepo;
  let mainSha: string;

  /** Commits a new file under the message; returns the new commit's sha. */
  function commit(message: string): string {
    repo.write(`f${repo.git('rev-list', '--all', '--count').trim()}.txt`, message);
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', message);
    return repo.git('rev-parse', 'HEAD').trim();
  }

  beforeEach(() => {
    repo = new TempRepo('commit-subjects').init();
    mainSha = commit('first, before the rule');
    repo.git('branch', '-M', 'main');
    repo.git('checkout', '-q', '-b', 'change');
  });
  afterEach(() => repo.remove());

  it('fails an untyped subject in the branch, passes once it is reworded, and ignores main before it', () => {
    commit('tools: publish');
    const failed = repo.run(CLI, ['--base', 'main']);
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stdout, /^commit-subjects: 1 of 1 commit\(s\) in main\.\.HEAD have a subject/);
    repo.git('commit', '-q', '--amend', '-m', 'feat(tools): publish');
    const passed = repo.run(CLI, ['--base', 'main']);
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /^commit-subjects: 1 commit\(s\) in main\.\.HEAD, each subject/);
  });

  it('refuses an option it does not know, named on stderr, and checks nothing', () => {
    const result = repo.run(CLI, ['--bse', 'main']);
    assert.equal(result.status, EXIT_USAGE);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^commit-subjects: .*'--bse'/);
  });

  it('compares with origin/main by default', () => {
    repo.git('update-ref', 'refs/remotes/origin/main', mainSha);
    commit('fix: a thing');
    const result = repo.run(CLI);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /in origin\/main\.\.HEAD/);
  });

  it('checks the head commit alone on a run by hand, which names no base', () => {
    commit('tools: older, not this run\'s');
    const head = commit('chore(main): release teamrig 1.0.0');
    const event = join(repo.outside, 'event.json');
    writeFileSync(event, JSON.stringify({}));
    const result = repo.run(CLI, ['--github'], { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: event, GITHUB_SHA: head });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^commit-subjects: 1 commit\(s\) in [0-9a-f]{40}~1\.\.[0-9a-f]{40}, each subject/);
  });

  it("takes a pull request's base and head from the GitHub Actions event with --github", () => {
    const head = commit('wip');
    const event = join(repo.outside, 'event.json');
    writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: mainSha }, head: { sha: head } } }));
    const result = repo.run(CLI, ['--github'], { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_SHA: head });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /"wip": it does not start with/);
  });
});
