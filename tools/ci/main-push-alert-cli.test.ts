import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTHOR, TempRepo } from '../lib/temp-repo.ts';
import { GITHUB_COMMITTER } from './main-push-alert.ts';

const CLI = fileURLToPath(new URL('./main-push-alert-cli.ts', import.meta.url));
const AFTER = 'b'.repeat(40);

describe('main-push-alert cli', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo('main-push-alert');
  });
  afterEach(() => repo.remove());

  /** Writes a push event whose head commit has this committer; returns the environment that points at it. */
  function pushEnv(committer: string): Record<string, string> {
    const event = join(repo.outside, 'event.json');
    writeFileSync(event, JSON.stringify({ before: 'a'.repeat(40), after: AFTER, forced: false, pusher: { name: 'dana' }, head_commit: { committer: { email: committer } } }));
    return { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event };
  }

  it('exits 0 without opening an issue for a pull request merge', () => {
    const result = repo.run(CLI, [], pushEnv(GITHUB_COMMITTER));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trimEnd(), `main-push-alert: ${AFTER} is a pull request merge, no alert`);
  });

  it('fails the run, so GitHub reports it, when the issue cannot be opened', () => {
    const result = repo.run(CLI, [], { ...pushEnv(AUTHOR.email), PATH: repo.outside });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^main-push-alert: .*\bgh\b.*ENOENT/m);
  });

  it('exits 2 with the reason outside a push event', () => {
    const result = repo.run(CLI);
    assert.equal(result.status, 2);
    assert.equal(result.stderr.trimEnd(), 'main-push-alert: needs a push event: GITHUB_EVENT_NAME=push and GITHUB_EVENT_PATH');
  });
});
