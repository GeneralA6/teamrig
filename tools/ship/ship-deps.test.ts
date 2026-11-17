import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { TempRepo } from '../lib/temp-repo.ts';
import { profileFor, readProfiles } from './repos.ts';
import { realShipDeps } from './ship-deps.ts';

const ORIGIN = 'https://github.com/GeneralA6/teamrig.git';

/** Runs only the deps that stay inside a temp repo; sync, mainMove, proveTree, push and merge reach origin or run the checks. */
describe('realShipDeps', () => {
  let repo: TempRepo;
  let base: string;

  beforeEach(() => {
    repo = new TempRepo('ship-deps').init();
    repo.write('a.txt', 'a\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'a');
    base = repo.git('rev-parse', 'HEAD').trim();
    repo.git('update-ref', 'refs/remotes/origin/main', base);
    repo.git('remote', 'add', 'origin', ORIGIN);
  });
  afterEach(() => repo.remove());

  it("takes the repo's profile by its origin: its merge checks", () => {
    assert.equal(realShipDeps(repo.dir, null).mergeChecks, profileFor(readProfiles(), 'GeneralA6/teamrig').mergeChecks);
  });

  it('refuses a repo whose origin repos.json does not list', () => {
    repo.git('remote', 'set-url', 'origin', 'https://github.com/example/unlisted.git');
    assert.throws(() => realShipDeps(repo.dir, null), /no check list for example\/unlisted/);
  });

  it('runs git, a command and node in the repo dir, and logs', () => {
    const deps = realShipDeps(repo.dir, null);
    assert.equal(deps.git(['rev-parse', 'HEAD']).trim(), base);
    deps.run('git', ['rev-parse', '--git-dir']);
    deps.node(['-e', 'process.exitCode = 0']);
    deps.log('logged');
    assert.throws(() => deps.run('git', ['rev-parse', 'refs/heads/no-such-ref']));
  });

  it('takes back nothing when no earlier run committed, and throws on a base git does not know', () => {
    const deps = realShipDeps(repo.dir, null);
    const chunks = [{ files: ['b.txt'], subject: 'core: b', body: 'why b' }];
    deps.takeBack(chunks, base);
    assert.equal(repo.git('rev-parse', 'HEAD').trim(), base);
    assert.throws(() => deps.takeBack(chunks, 'refs/heads/no-such-base'));
  });

  it("reads the build's steps from the repo's package.json", () => {
    repo.write('package.json', JSON.stringify({ scripts: { build: 'node a.ts && node b.ts --x' } }));
    assert.deepEqual(realShipDeps(repo.dir, null).buildSteps(), [['a.ts'], ['b.ts', '--x']]);
  });

  it("reads a head's work commits and its patch against origin's main", () => {
    repo.write('b.txt', 'b\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'core: b');
    const deps = realShipDeps(repo.dir, null);
    assert.deepEqual(deps.workOf('HEAD').map((commit) => [commit.subject, commit.merge]), [['core: b', false]]);
    assert.match(deps.patchOf('HEAD'), /^[0-9a-f]+$/);
    assert.equal(deps.patchOf('HEAD'), deps.patchOf(repo.git('rev-parse', 'HEAD').trim()));
  });
});
