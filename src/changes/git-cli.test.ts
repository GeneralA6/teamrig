import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIT_CHANGES } from './git.ts';

/** A throwaway repository with fixed commit times, so the real git CLI's output is read as `GIT_CHANGES` reads it. */
const repo = mkdtempSync(join(tmpdir(), 'teamrig-changes-git-'));
after(() => rmSync(repo, { recursive: true, force: true }));

function git(args: readonly string[], at = '2026-11-14T10:00:00Z'): string {
  const result = spawnSync('git', ['-c', 'user.name=spec', '-c', 'user.email=', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function commit(subject: string, at: string, file: string): void {
  mkdirSync(join(repo, file, '..'), { recursive: true });
  writeFileSync(join(repo, file), subject);
  git(['add', '--', file], at);
  git(['commit', '-q', '-m', subject], at);
}

git(['init', '-q', '-b', 'main']);
commit('feat: the first one', '2026-11-14T10:00:00Z', 'a.txt');
commit('plugin: version 0.1.0, x', '2026-11-14T12:00:00Z', 'version.txt');
commit('fix(open): a console tab (T1)', '2026-11-15T10:00:00Z', 'src/open/tab.ts');
commit('feat: tagged', '2026-11-15T12:00:00Z', 'b.txt');
git(['tag', '-a', 'v0.2.0', '-m', 'v0.2.0'], '2026-11-15T12:00:00Z');
commit('feat(cli): not released yet', '2026-11-16T10:00:00Z', 'src/cli/c.ts');

describe('GIT_CHANGES on the git CLI', () => {
  it('indexes the releases from a version tag and a commit naming its version, newest first', async () => {
    const releases = await GIT_CHANGES.releases(repo);
    assert.deepEqual(
      releases.map((release) => [release.version, release.at]),
      [
        ['0.2.0', '2026-11-15T12:00:00.000Z'],
        ['0.1.0', '2026-11-14T12:00:00.000Z'],
      ],
    );
    assert.equal(releases[0]?.sha, git(['rev-parse', 'HEAD~1']).trim(), "an annotated tag names its commit, not the tag object");
  });

  it('logs a range by its release commit, with each commit\'s files, and by time', async () => {
    const [, first] = await GIT_CHANGES.releases(repo);
    assert.ok(first !== undefined);
    const since = { version: first.version, at: first.at, ref: first.sha };
    const all = await GIT_CHANGES.log(repo, { since, until: undefined, paths: [] });
    assert.deepEqual(
      all.map((one) => [one.subject, one.files]),
      [
        ['feat(cli): not released yet', ['src/cli/c.ts']],
        ['feat: tagged', ['b.txt']],
        ['fix(open): a console tab (T1)', ['src/open/tab.ts']],
      ],
    );
    const inOpen = await GIT_CHANGES.log(repo, { since, until: undefined, paths: ['src/open/'] });
    assert.deepEqual(inOpen.map((one) => one.subject), ['fix(open): a console tab (T1)']);
    const byTime = await GIT_CHANGES.log(repo, { since: { version: undefined, at: '2026-11-16T00:00:00.000Z', ref: undefined }, until: undefined, paths: [] });
    assert.deepEqual(byTime.map((one) => [one.subject, one.at]), [['feat(cli): not released yet', '2026-11-16T10:00:00.000Z']]);
  });

  it("rejects with git's own words when the folder holds no repository", async () => {
    const empty = mkdtempSync(join(tmpdir(), 'teamrig-changes-nogit-'));
    after(() => rmSync(empty, { recursive: true, force: true }));
    await assert.rejects(GIT_CHANGES.log(empty, { since: { version: undefined, at: undefined, ref: undefined }, until: undefined, paths: [] }), /not a git repository/);
  });
});
