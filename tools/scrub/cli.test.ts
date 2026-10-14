import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TempRepo } from '../lib/temp-repo.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
// Fixtures are assembled at runtime so this file never holds a literal the scrub would flag.
const AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const INTERNAL_HOST = ['build', 'corp'].join('.');

describe('scrub cli', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo('scrub').init();
  });
  afterEach(() => repo.remove());

  it('passes a clean tree', () => {
    repo.write('README.md', 'hello\n');
    repo.git('add', '-A');
    const result = repo.run(CLI, ['--tree']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^scrub: clean \(/m);
  });

  it('reports a secret in the tree and exits 1', () => {
    repo.write('config.txt', `key ${AWS_KEY}\n`);
    repo.git('add', '-A');
    const result = repo.run(CLI, ['--tree']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /aws-key/);
    assert.doesNotMatch(result.stdout, new RegExp(AWS_KEY));
    assert.match(result.stdout, /^scrub: 1 finding\(s\) \(/m);
  });

  it('scans the messages of the commits a GitHub Actions event names with --github', () => {
    repo.git('commit', '-q', '--allow-empty', '-m', `deploy to ${INTERNAL_HOST}`);
    const event = join(repo.outside, 'event.json');
    writeFileSync(event, JSON.stringify({ before: '0'.repeat(40) }));
    const sha = repo.git('rev-parse', 'HEAD').trim();
    const result = repo.run(CLI, ['--github'], { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_SHA: sha });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /internal-host/);
  });

  it('exits 2 with nothing to scan or an unknown option', () => {
    const none = repo.run(CLI);
    assert.equal(none.status, 2, none.stderr);
    assert.match(none.stdout, /^scrub: nothing to scan; /);
    const unknown = repo.run(CLI, ['--bogus']);
    assert.equal(unknown.status, 2, unknown.stdout);
    assert.match(unknown.stderr, /^scrub: Unknown option '--bogus'/);
  });
});
