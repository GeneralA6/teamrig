import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readCommits } from './commits.ts';
import { FakeGit } from './fake-git.ts';

const LOG_ARGS = 'log --format=%H%x00%an%x00%ae%x00%P%x00%B%x1e';

describe('readCommits', () => {
  it('parses every record, including merges and multi-line messages', async () => {
    const raw =
      'aaa\x00Alpha\x00alpha@example.com\x00ppp\x00first line\n\nbody\n\x1e\n' +
      'bbb\x00Bravo\x00bravo@example.com\x00p1 p2\x00Merge\n\x1e\n';
    const git = new FakeGit({ [`${LOG_ARGS} main..dev --`]: raw });

    const commits = await readCommits(git, 'main..dev');

    assert.deepEqual(commits, [
      { sha: 'aaa', authorName: 'Alpha', authorEmail: 'alpha@example.com', parents: ['ppp'], message: 'first line\n\nbody\n' },
      { sha: 'bbb', authorName: 'Bravo', authorEmail: 'bravo@example.com', parents: ['p1', 'p2'], message: 'Merge\n' },
    ]);
  });

  it('returns no commits for an empty range', async () => {
    const git = new FakeGit({ [`${LOG_ARGS} a..a --`]: '' });
    assert.deepEqual(await readCommits(git, 'a..a'), []);
  });

  it('rejects a record with missing fields', async () => {
    const git = new FakeGit({ [`${LOG_ARGS} x --`]: 'only-a-sha\x1e' });
    await assert.rejects(readCommits(git, 'x'), /unexpected git log record/);
  });
});
