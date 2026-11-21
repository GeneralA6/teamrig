import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { TempRepo } from '../lib/temp-repo.ts';
import { profileFor, readProfiles } from './repos.ts';
import { shipCommits } from './ship-commits.ts';
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

  it('syncs, sees main move and pushes the branch against origin, here a bare repo beside the temp repo', () => {
    repo.write('plugins/teamrig/.claude-plugin/plugin.json', '{ "version": "0.1.0" }\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'version');
    // The profile is read from origin's URL once, when the deps are made: origin then moves to a bare repo, so the
    // fetches and the push stay on this machine. A global core.hooksPath must not run a real hook on the push.
    const deps = realShipDeps(repo.dir, null);
    const origin = join(repo.outside, 'origin.git');
    repo.git('init', '-q', '--bare', origin);
    repo.git('config', 'core.hooksPath', join(repo.outside, 'no-hooks'));
    repo.git('remote', 'set-url', 'origin', origin);
    repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    repo.git('checkout', '-q', '-b', 'feat/change');

    assert.deepEqual(deps.sync(), { kind: 'current', sets: '0.1.0' });
    assert.equal(deps.mainMove(), null);
    assert.equal(deps.push(), 'feat/change');
    assert.equal(repo.git('ls-remote', origin, 'refs/heads/feat/change').split('\t')[0], repo.git('rev-parse', 'HEAD').trim());

    repo.git('commit', '-q', '--allow-empty', '-m', 'main moves');
    repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    repo.git('reset', '-q', '--hard', 'HEAD~1');
    assert.match(deps.mainMove()?.reason ?? '', /^origin\/main moved to [0-9a-f]{7}, which the branch does not contain$/);
  });

  it('a refusal after the take back and the rebase leaves the branch on the head the run started from, the tree clean (#1240)', async () => {
    repo.write('plugins/teamrig/.claude-plugin/plugin.json', '{ "version": "0.1.0" }\n');
    repo.write('src/core/version.ts', "export const KIT_VERSION = '0.1.0';\n");
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'version');
    const deps = realShipDeps(repo.dir, null);
    const origin = join(repo.outside, 'origin.git');
    repo.git('init', '-q', '--bare', origin);
    repo.git('config', 'core.hooksPath', join(repo.outside, 'no-hooks'));
    repo.git('config', 'commit.gpgsign', 'false');
    repo.git('remote', 'set-url', 'origin', origin);
    repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    repo.write('m.txt', 'm\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'main moves');
    repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    repo.git('reset', '-q', '--hard', 'HEAD~1');
    repo.git('checkout', '-q', '-b', 'feat/change');
    // The earlier run's commit of the plan's first chunk, the head an approver reviewed; the second chunk has nothing
    // left to commit, so this run is refused after it took that commit back and rebased onto the moved main.
    repo.write('b.txt', 'b\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'core: b');
    const start = repo.git('rev-parse', 'HEAD').trim();
    const plan = [
      { files: ['b.txt'], subject: 'core: b', body: 'why b' },
      { files: ['c.txt'], subject: 'core: c', body: 'why c' },
    ];
    const args = { repo: repo.dir, plan: 'plan.json', base: 'origin/main', merge: false, noteFile: null, approved: null };

    await assert.rejects(shipCommits(args, plan, deps), /^Error: REFUSED the plan's chunk "core: c" commits nothing/);
    assert.equal(repo.git('rev-parse', 'HEAD').trim(), start);
    assert.equal(repo.git('status', '--porcelain'), '');
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
