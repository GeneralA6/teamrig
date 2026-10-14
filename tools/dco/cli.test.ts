import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTHOR, TempRepo } from '../lib/temp-repo.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const SIGNOFF = `Signed-off-by: ${AUTHOR.name} <${AUTHOR.email}>`;

describe('dco cli', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo('dco').init();
  });
  afterEach(() => repo.remove());

  /** Commits an empty change with the given message paragraphs; returns its sha. */
  function commit(...paragraphs: readonly string[]): string {
    repo.git('commit', '-q', '--allow-empty', ...paragraphs.flatMap((paragraph) => ['-m', paragraph]));
    return repo.git('rev-parse', 'HEAD').trim();
  }

  it('checks a message file against the author (the commit-msg hook)', () => {
    const signed = repo.write('signed.txt', `add a thing\n\n${SIGNOFF}\n`);
    assert.deepEqual(repo.run(CLI, ['--message', signed]), { status: 0, stdout: '', stderr: '' });
    const unsigned = repo.write('unsigned.txt', 'add a thing\n');
    const result = repo.run(CLI, ['--message', unsigned]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, 'dco: no Signed-off-by line; commit with `git commit -s`\n');
  });

  it('checks every commit in a range', () => {
    commit('first', SIGNOFF);
    const result = repo.run(CLI, ['--range', 'HEAD']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'dco: 1 commit(s) signed off\n');
  });

  it('takes the range from the GitHub Actions event with --github', () => {
    const sha = commit('unsigned');
    const event = join(repo.outside, 'event.json');
    writeFileSync(event, JSON.stringify({ before: '0'.repeat(40) }));
    const result = repo.run(CLI, ['--github'], { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_SHA: sha });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^dco: 1 of 1 commit\(s\) not signed off$/m);
  });

  it('exits 2 with no check to run, an unknown option or --github outside Actions', () => {
    const none = repo.run(CLI);
    assert.equal(none.status, 2, none.stderr);
    assert.equal(none.stdout, 'dco: pass --message <file>, --range <revisions> or --github\n');
    const unknown = repo.run(CLI, ['--bogus']);
    assert.equal(unknown.status, 2, unknown.stdout);
    assert.match(unknown.stderr, /^dco: Unknown option '--bogus'/);
    const github = repo.run(CLI, ['--github']);
    assert.equal(github.status, 2, github.stdout);
    assert.equal(github.stderr, 'dco: --github needs GITHUB_EVENT_NAME, GITHUB_EVENT_PATH and GITHUB_SHA\n');
  });
});
