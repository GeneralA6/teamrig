import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELETED_FORK,
  forkOfPull,
  githubEventFromEnv,
  type GithubEvent,
  rangeFromGithubEnv,
  rangeFromGithubEvent,
  revisionsFromGithubEnv,
  revisionsFromGithubEvent,
} from './github-range.ts';

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

describe('revisionsFromGithubEvent', () => {
  it("gives a pull request's base and head apart", () => {
    const payload = { pull_request: { base: { sha: 'base1' }, head: { sha: 'head1' } } };
    assert.deepEqual(revisionsFromGithubEvent('pull_request_target', payload, 'merge'), { base: 'base1', head: 'head1' });
  });

  it("gives a push's commit before and after, with no base for a new branch", () => {
    assert.deepEqual(revisionsFromGithubEvent('push', { before: 'b1', after: 'a1' }, 'head'), { base: 'b1', head: 'a1' });
    assert.deepEqual(revisionsFromGithubEvent('push', { before: ZERO }, 'head'), { base: undefined, head: 'head' });
  });

  it('gives the head alone for any other event', () => {
    assert.deepEqual(revisionsFromGithubEvent('schedule', {}, 'head'), { base: undefined, head: 'head' });
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

describe('revisionsFromGithubEnv', () => {
  it('reads the ends from the event payload named by the environment', async () => {
    const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: 'event.json', GITHUB_SHA: 'merge' };
    const payload = { pull_request: { base: { sha: 'base1' }, head: { sha: 'head1' } } };
    assert.deepEqual(await revisionsFromGithubEnv(env, async () => JSON.stringify(payload)), { base: 'base1', head: 'head1' });
  });

  it('rejects an incomplete environment', async () => {
    await assert.rejects(revisionsFromGithubEnv({ GITHUB_SHA: 'head' }, async () => '{}'), /--github needs/);
  });
});

describe('githubEventFromEnv', () => {
  it('reads the event name, its payload and the checked-out sha', async () => {
    const env = { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: 'event.json', GITHUB_SHA: 'head' };
    assert.deepEqual(await githubEventFromEnv(env, async () => '{"before":"b1"}'), { name: 'push', payload: { before: 'b1' }, headSha: 'head' });
  });

  it('rejects an incomplete environment', async () => {
    await assert.rejects(githubEventFromEnv({ GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'head' }, async () => '{}'), /--github needs/);
  });
});

describe('forkOfPull', () => {
  const pull = (base: unknown, head: unknown): GithubEvent => ({ name: 'pull_request', payload: { pull_request: { base: { repo: base }, head: { repo: head } } }, headSha: 'merge' });

  it("names the fork a pull request comes from, and none for a branch of the repository itself", () => {
    assert.equal(forkOfPull(pull({ full_name: 'owner/repo' }, { full_name: 'someone/repo' })), 'someone/repo');
    assert.equal(forkOfPull(pull({ full_name: 'owner/repo' }, { full_name: 'owner/repo' })), null);
    assert.equal(forkOfPull({ ...pull({ full_name: 'owner/repo' }, { full_name: 'someone/repo' }), name: 'pull_request_target' }), 'someone/repo');
  });

  it('calls a head repository GitHub no longer has a deleted fork', () => {
    assert.equal(forkOfPull(pull({ full_name: 'owner/repo' }, null)), DELETED_FORK);
  });

  it('names no fork for any other event', () => {
    assert.equal(forkOfPull({ name: 'push', payload: { pull_request: { base: { repo: { full_name: 'a/b' } }, head: { repo: { full_name: 'c/d' } } } }, headSha: 'head' }), null);
  });

  it("rejects a pull request event that does not name its repositories, rather than call it the repository's own", () => {
    assert.throws(() => forkOfPull(pull({}, { full_name: 'someone/repo' })), /without the base repository's name/);
    assert.throws(() => forkOfPull(pull({ full_name: 'owner/repo' }, { name: 'repo' })), /without the head repository's name/);
  });
});
