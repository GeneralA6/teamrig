import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { GitError, type Git } from '../lib/git.ts';
import { AUTHOR, TempRepo } from '../lib/temp-repo.ts';
import { publicationProblem, publishRelease, type Publication } from './publish.ts';

const DIST = 'plugins/x/dist';

/** git in the temp repo's own environment, so no global config of the machine running the tests reaches it. */
function gitIn(repo: TempRepo): Git {
  const run = (args: readonly string[]): Buffer => {
    const result = spawnSync('git', [...args], { cwd: repo.dir, env: repo.env });
    if (result.status !== 0) throw new GitError(args, result.stderr.toString('utf8'), result.status);
    return result.stdout;
  };
  return { text: async (args) => run(args).toString('utf8'), bytes: async (args) => run(args) };
}

describe('publishRelease', () => {
  let repo: TempRepo;
  let git: Git;
  let origin: string;
  const lines: string[] = [];

  /** Commits a change to main's source and returns its sha, with a fresh dist built beside it (untracked). */
  function release(content: string): string {
    repo.write('plugins/x/src.ts', content);
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', `change ${content}`);
    repo.write(`${DIST}/index.js`, `built ${content}`);
    return repo.git('rev-parse', 'HEAD').trim();
  }

  const at = (source: string, version: string): Publication => ({ version, source, branch: 'release', dist: DIST, remote: 'origin' });
  const remote = (ref: string): string => repo.git('ls-remote', origin, ref).split('\t')[0] ?? '';

  beforeEach(() => {
    repo = new TempRepo('release').init();
    origin = join(repo.outside, 'origin.git');
    repo.git('init', '-q', '--bare', origin);
    repo.git('remote', 'add', 'origin', origin);
    repo.write('.gitignore', 'plugins/x/dist/\n');
    git = gitIn(repo);
    lines.length = 0;
  });

  afterEach(() => repo.remove());

  it('makes the first release the source with its ignored dist on top, signed off, on the branch and its tag', async () => {
    const source = release('one');
    const commit = await publishRelease(git, at(source, '1.0.0'), (line) => lines.push(line));
    assert.equal(remote('refs/heads/release'), commit);
    assert.equal(remote('refs/tags/v1.0.0'), commit);
    assert.equal(repo.git('log', '-1', '--format=%P', commit).trim(), source);
    assert.equal(repo.git('show', `${commit}:${DIST}/index.js`), 'built one');
    assert.equal(repo.git('show', `${commit}:plugins/x/src.ts`), 'one');
    assert.equal(
      repo.git('log', '-1', '--format=%B', commit).trim(),
      `release: teamrig 1.0.0\n\nThe plugin as main's ${source} holds it, with ${DIST} built by the release workflow.\n\nSigned-off-by: ${AUTHOR.name} <${AUTHOR.email}>`,
    );
    assert.deepEqual(lines, [`release: published 1.0.0 as ${commit} on release, tagged v1.0.0`]);
  });

  it('makes the next release a child of the last one and of its source, so the branch only moves forward', async () => {
    const first = await publishRelease(git, at(release('one'), '1.0.0'), () => {});
    const source = release('two');
    const commit = await publishRelease(git, at(source, '1.1.0'), () => {});
    assert.equal(repo.git('log', '-1', '--format=%P', commit).trim(), `${first} ${source}`);
    assert.equal(remote('refs/heads/release'), commit);
    assert.equal(remote('refs/tags/v1.0.0'), first);
    assert.equal(repo.git('show', `${commit}:${DIST}/index.js`), 'built two');
  });

  it('changes nothing when run again for a release already published', async () => {
    const source = release('one');
    const commit = await publishRelease(git, at(source, '1.0.0'), () => {});
    assert.equal(await publishRelease(git, at(source, '1.0.0'), (line) => lines.push(line)), commit);
    assert.deepEqual(lines, [`release: release and v1.0.0 already hold ${commit}, nothing to publish`]);
    assert.equal(remote('refs/heads/release'), commit);
  });

  it('tags a published release whose tag push was lost, without a new commit', async () => {
    const source = release('one');
    const commit = await publishRelease(git, at(source, '1.0.0'), () => {});
    repo.git('push', '-q', origin, ':refs/tags/v1.0.0');
    assert.equal(await publishRelease(git, at(source, '1.0.0'), (line) => lines.push(line)), commit);
    assert.equal(remote('refs/tags/v1.0.0'), commit);
    assert.deepEqual(lines, [`release: release already held ${commit}; tagged it v1.0.0`]);
  });

  it('never moves a tag that names another commit, and leaves the branch where it was', async () => {
    const first = await publishRelease(git, at(release('one'), '1.0.0'), () => {});
    await assert.rejects(publishRelease(git, at(release('two'), '1.0.0'), () => {}), new RegExp(`v1\\.0\\.0 already tags ${first}; a tag never moves`));
    assert.equal(remote('refs/heads/release'), first);
  });

  it('never moves a tag of the same build that names another commit', async () => {
    const source = release('one');
    const commit = await publishRelease(git, at(source, '0.9.0'), () => {});
    repo.git('push', '-q', '--force', origin, `${source}:refs/tags/v0.9.0`);
    await assert.rejects(publishRelease(git, at(source, '0.9.0'), () => {}), new RegExp(`v0\\.9\\.0 already tags ${source}, not the release ${commit}`));
  });

  it('refuses a checkout that is not at the source', async () => {
    const source = release('one');
    await assert.rejects(publishRelease(git, at('a'.repeat(40), '1.0.0'), () => {}), new RegExp(`the checkout is at ${source}, not the release's source a{40}`));
    assert.equal(remote('refs/heads/release'), '');
  });

  it('refuses a source with no dist built', async () => {
    repo.write('plugins/x/src.ts', 'one');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'change one');
    const source = repo.git('rev-parse', 'HEAD').trim();
    await assert.rejects(publishRelease(git, at(source, '1.0.0'), () => {}), new RegExp(`no ${DIST} was built to publish`));
    assert.equal(remote('refs/heads/release'), '');
  });
});

describe('publicationProblem', () => {
  const good: Publication = { version: '0.448.0', source: 'f'.repeat(40), branch: 'release', dist: 'dist', remote: 'origin' };

  it('takes a MAJOR.MINOR.PATCH version and a full sha', () => {
    assert.equal(publicationProblem(good), undefined);
  });

  it('refuses a version with a prefix or a pre-release, and a short or named source', () => {
    assert.equal(publicationProblem({ ...good, version: 'v0.448.0' }), 'the version v0.448.0 is not MAJOR.MINOR.PATCH');
    assert.equal(publicationProblem({ ...good, version: '0.448.0-rc.1' }), 'the version 0.448.0-rc.1 is not MAJOR.MINOR.PATCH');
    assert.equal(publicationProblem({ ...good, source: 'main' }), 'the source main is not a full commit sha');
    assert.equal(publicationProblem({ ...good, source: 'f'.repeat(39) }), `the source ${'f'.repeat(39)} is not a full commit sha`);
  });
});
