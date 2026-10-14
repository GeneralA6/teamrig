import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rangeFromGithubEnv, rangeFromGithubEvent } from './github-range.ts';

const ZERO = '0'.repeat(40);

describe('rangeFromGithubEvent', () => {
  it('checks only the new commits of a push to an existing branch', () => {
    assert.equal(rangeFromGithubEvent('push', { before: 'b1', after: 'a1' }, 'head'), 'b1..a1');
  });

  it('checks the whole history of a newly created branch', () => {
    assert.equal(rangeFromGithubEvent('push', { before: ZERO, after: 'a1' }, 'head'), 'a1');
  });

  it("checks a pull request's own commits", () => {
    const payload = { pull_request: { base: { sha: 'base1' }, head: { sha: 'head1' } } };
    assert.equal(rangeFromGithubEvent('pull_request', payload, 'merge'), 'base1..head1');
  });

  it('rejects a pull request event without shas', () => {
    assert.throws(() => rangeFromGithubEvent('pull_request', { pull_request: {} }, 'head'), /without base and head/);
  });

  it('checks the whole history for any other event or an unreadable payload', () => {
    assert.equal(rangeFromGithubEvent('workflow_dispatch', {}, 'head'), 'head');
    assert.equal(rangeFromGithubEvent('push', 'not an object', 'head'), 'head');
  });
});

describe('rangeFromGithubEnv', () => {
  it('reads the event payload named by the environment', async () => {
    const env = { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: 'event.json', GITHUB_SHA: 'head' };
    const readText = async (path: string): Promise<string> => {
      assert.equal(path, 'event.json');
      return JSON.stringify({ before: 'b1', after: 'a1' });
    };
    assert.equal(await rangeFromGithubEnv(env, readText), 'b1..a1');
  });

  it('rejects an incomplete environment', async () => {
    await assert.rejects(rangeFromGithubEnv({ GITHUB_EVENT_NAME: 'push' }, async () => '{}'), /--github needs/);
  });
});
