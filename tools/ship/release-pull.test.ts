import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { TempRepo } from '../lib/temp-repo.ts';
import { teamrigShipWritesOf } from './approval.ts';
import { releaseRefusal } from './release-pull.ts';
import { profileFor, readProfiles, type ReleasePull } from './repos.ts';
import { TEAMRIG_SHIP_VERSION_FILES } from './version-bump.ts';

const PLUGIN = 'plugins/teamrig/.claude-plugin/plugin.json';
const VERSION_TS = 'src/core/version.ts';
const RELEASE_MANIFEST = '.release-please-manifest.json';
const CHANGELOG = 'CHANGELOG.md';
const RELEASE: ReleasePull = { head: 'release-please--branches--main', changelog: CHANGELOG };

const plugin = (version: string, more = ''): string => `{\n  "name": "teamrig",\n  "version": "${version}"${more}\n}\n`;
const versionTs = (version: string): string => `export const KIT_VERSION = '${version}';\n`;
const releaseManifest = (version: string): string => `{\n  ".": "${version}"\n}\n`;
const NOTES_BASE = '# Changelog\n\n## 0.1.0\n\n- first\n';
const notesWith = (version: string): string => NOTES_BASE.replace('# Changelog\n', `# Changelog\n\n## ${version}\n\n- a feature\n`);

describe('releaseRefusal: the release pull request merges only when it holds only a release (T4645)', () => {
  let repo: TempRepo;
  const git = (args: readonly string[]): string => repo.git(...args);
  const commitFiles = (subject: string, files: Readonly<Record<string, string>>): string => {
    for (const [path, text] of Object.entries(files)) repo.write(path, text);
    repo.git('add', '--', ...Object.keys(files));
    repo.git('commit', '-q', '-m', subject);
    return repo.git('rev-parse', 'HEAD').trim();
  };
  const versions = (version: string): Record<string, string> => ({ [PLUGIN]: plugin(version), [VERSION_TS]: versionTs(version), [RELEASE_MANIFEST]: releaseManifest(version) });
  const release = (version: string): string => commitFiles(`chore(main): release ${version}`, { ...versions(version), [CHANGELOG]: notesWith(version) });
  const refusal = (sha: string): string | null => releaseRefusal(git, 'main', sha, RELEASE, TEAMRIG_SHIP_VERSION_FILES);

  beforeEach(() => {
    repo = new TempRepo('release-pull').init();
    repo.git('symbolic-ref', 'HEAD', 'refs/heads/main');
    commitFiles('base', { ...versions('0.1.0'), [CHANGELOG]: NOTES_BASE, 'src/a.ts': 'a\n' });
    repo.git('checkout', '-q', '-b', RELEASE.head);
  });

  afterEach(() => repo.remove());

  it('clears a head that raises every version file to one version and adds the notes', () => {
    assert.equal(refusal(release('0.2.0')), null);
  });

  it('clears it when main moved on past the release branch, reading the change from their merge base', () => {
    const sha = release('0.2.0');
    repo.git('checkout', '-q', 'main');
    commitFiles('feat: more', { 'src/a.ts': 'a2\n' });
    assert.equal(refusal(sha), null);
  });

  it('refuses a head that also changes any other path, naming it', () => {
    const sha = commitFiles('chore(main): release 0.2.0', { ...versions('0.2.0'), [CHANGELOG]: notesWith('0.2.0'), 'src/a.ts': 'a, changed\n' });
    assert.match(refusal(sha) ?? '', /^src\/a\.ts is neither a version file nor the changelog CHANGELOG\.md/);
  });

  it('refuses a head of two commits, even when the second undoes what the first slipped in (T4712)', () => {
    commitFiles('feat: slipped in', { 'src/a.ts': 'a, changed\n' });
    const sha = commitFiles('chore(main): release 0.2.0', { ...versions('0.2.0'), [CHANGELOG]: notesWith('0.2.0'), 'src/a.ts': 'a\n' });
    assert.equal(refusal(sha), `the release pull request's head ${sha} is not one commit on main: release-please writes its release as exactly one`);
  });

  it('refuses a merge commit as the head (T4712)', () => {
    const released = release('0.2.0');
    repo.git('checkout', '-q', 'main');
    commitFiles('feat: more', { 'src/a.ts': 'a2\n' });
    repo.git('checkout', '-q', RELEASE.head);
    repo.git('merge', '-q', '--no-edit', '--no-ff', 'main');
    const sha = repo.git('rev-parse', 'HEAD').trim();
    assert.notEqual(sha, released);
    assert.equal(refusal(sha), `the release pull request's head ${sha} is not one commit on main: release-please writes its release as exactly one`);
  });

  it('refuses a version file changed past its version token', () => {
    const sha = commitFiles('chore(main): release 0.2.0', { ...versions('0.2.0'), [PLUGIN]: plugin('0.2.0', ',\n  "hooks": "./hooks.json"'), [CHANGELOG]: notesWith('0.2.0') });
    assert.equal(refusal(sha), `${PLUGIN} changes more than its version token`);
  });

  it('refuses a version that does not rise over the merge base', () => {
    const sha = commitFiles('chore(main): release 0.0.9', versions('0.0.9'));
    assert.equal(refusal(sha), `${RELEASE_MANIFEST} sets version 0.0.9, which does not raise 0.1.0`);
  });

  it('refuses a head that leaves a version file unraised', () => {
    const sha = commitFiles('chore(main): release 0.2.0', { [PLUGIN]: plugin('0.2.0'), [VERSION_TS]: versionTs('0.2.0'), [CHANGELOG]: notesWith('0.2.0') });
    assert.equal(refusal(sha), `the release pull request leaves the version of ${RELEASE_MANIFEST} as it was: a release raises every version file`);
  });

  it('refuses version files raised to different versions', () => {
    const sha = commitFiles('chore(main): release 0.2.0', { ...versions('0.2.0'), [VERSION_TS]: versionTs('0.3.0') });
    assert.equal(refusal(sha), 'the version files name more than one version: 0.2.0, 0.3.0');
  });

  it('refuses a changelog line deleted or rewritten', () => {
    const sha = commitFiles('chore(main): release 0.2.0', { ...versions('0.2.0'), [CHANGELOG]: notesWith('0.2.0').replace('- first\n', '- rewritten\n') });
    assert.equal(refusal(sha), `${CHANGELOG} deletes or rewrites 1 line(s): the release pull request may only add its version's notes`);
  });

  it('refuses changelog notes added in a second place (T4712)', () => {
    const sha = commitFiles('chore(main): release 0.2.0', { ...versions('0.2.0'), [CHANGELOG]: `${notesWith('0.2.0')}- slipped at the end\n` });
    assert.equal(refusal(sha), `${CHANGELOG} changes 2 places: the release pull request adds its version's notes in one block`);
  });

  it('refuses changelog lines added above its title (T4712)', () => {
    const sha = commitFiles('chore(main): release 0.2.0', { ...versions('0.2.0'), [CHANGELOG]: `## 0.2.0\n\n${NOTES_BASE}` });
    assert.equal(refusal(sha), `${CHANGELOG} adds lines above its title: the release pull request adds its version's notes below it`);
  });

  it('refuses a changelog made executable', () => {
    repo.write(CHANGELOG, notesWith('0.2.0'));
    repo.git('add', '--', CHANGELOG);
    repo.git('update-index', '--chmod=+x', CHANGELOG);
    const sha = commitFiles('chore(main): release 0.2.0', versions('0.2.0'));
    assert.equal(refusal(sha), `${CHANGELOG} is the changelog the release pull request may only add lines to, but its change is M 100644 to 100755`);
  });

  it('refuses a changelog the release adds, as main has one to add to (T4712)', () => {
    repo.git('checkout', '-q', 'main');
    repo.git('rm', '-q', CHANGELOG);
    repo.git('commit', '-q', '-m', 'docs: drop the notes');
    repo.git('checkout', '-q', '-B', RELEASE.head);
    const sha = commitFiles('chore(main): release 0.2.0', { ...versions('0.2.0'), [CHANGELOG]: notesWith('0.2.0') });
    assert.match(refusal(sha) ?? '', /^CHANGELOG\.md is the changelog the release pull request may only add lines to, but its change is A 000000 to 100644$/);
  });

  it('refuses a version file made executable (T4712)', () => {
    repo.write(PLUGIN, plugin('0.2.0'));
    repo.git('add', '--', PLUGIN);
    repo.git('update-index', '--chmod=+x', PLUGIN);
    const sha = commitFiles('chore(main): release 0.2.0', { [VERSION_TS]: versionTs('0.2.0'), [RELEASE_MANIFEST]: releaseManifest('0.2.0'), [CHANGELOG]: notesWith('0.2.0') });
    assert.equal(refusal(sha), `${PLUGIN} is a version file the release pull request must only edit, but its change is M 100644 to 100755`);
  });

  it('refuses a deleted version file', () => {
    repo.git('rm', '-q', RELEASE_MANIFEST);
    const sha = commitFiles('chore(main): release 0.2.0', { [PLUGIN]: plugin('0.2.0'), [VERSION_TS]: versionTs('0.2.0'), [CHANGELOG]: notesWith('0.2.0') });
    assert.equal(refusal(sha), `${RELEASE_MANIFEST} is a version file the release pull request must only edit, but its change is D 100644 to 000000`);
  });

  it('refuses a head that is main itself, as no commit of a release', () => {
    const sha = repo.git('rev-parse', 'HEAD').trim();
    assert.equal(refusal(sha), `the release pull request's head ${sha} is not one commit on main: release-please writes its release as exactly one`);
  });

  it('refuses a head that changes nothing over main', () => {
    repo.git('commit', '-q', '--allow-empty', '-m', 'chore(main): release 0.2.0');
    const sha = repo.git('rev-parse', 'HEAD').trim();
    assert.equal(refusal(sha), `the release pull request's head ${sha} changes nothing over main`);
  });
});

describe("releaseRefusal on teamrig-pane's release, read by the shipped repos.json as ship.ts merge reads it (T4821)", () => {
  const profile = profileFor(readProfiles(), 'teamrig/teamrig-pane');
  const PANE_PLUGIN = 'plugins/teamrig-pane/.claude-plugin/plugin.json';
  let repo: TempRepo;
  const commitFiles = (files: Readonly<Record<string, string>>): string => {
    for (const [path, text] of Object.entries(files)) repo.write(path, text);
    repo.git('add', '--', ...Object.keys(files));
    repo.git('commit', '-q', '-m', 'commit');
    return repo.git('rev-parse', 'HEAD').trim();
  };
  const paneVersions = (version: string): Record<string, string> => ({ [PANE_PLUGIN]: plugin(version), [RELEASE_MANIFEST]: releaseManifest(version) });
  const refusal = (sha: string): string | null => {
    if (profile.release === null) throw new Error('the shipped repos.json names no teamrig-pane release');
    return releaseRefusal((args) => repo.git(...args), 'main', sha, profile.release, teamrigShipWritesOf(profile.regenerated).versionFiles);
  };

  beforeEach(() => {
    repo = new TempRepo('release-pull-pane').init();
    repo.git('symbolic-ref', 'HEAD', 'refs/heads/main');
    commitFiles({ ...paneVersions('0.76.0'), [CHANGELOG]: NOTES_BASE, 'src/a.ts': 'a\n' });
    repo.git('checkout', '-q', '-b', profile.release?.head ?? 'release');
  });

  afterEach(() => repo.remove());

  it('clears a head that raises the plugin manifest and the release manifest to one version and adds the notes', () => {
    assert.equal(refusal(commitFiles({ ...paneVersions('0.77.0'), [CHANGELOG]: notesWith('0.77.0') })), null);
  });

  it('refuses a head that leaves the release manifest unraised', () => {
    const sha = commitFiles({ [PANE_PLUGIN]: plugin('0.77.0'), [CHANGELOG]: notesWith('0.77.0') });
    assert.equal(refusal(sha), `the release pull request leaves the version of ${RELEASE_MANIFEST} as it was: a release raises every version file`);
  });

  it('refuses a head that also changes code', () => {
    const sha = commitFiles({ ...paneVersions('0.77.0'), [CHANGELOG]: notesWith('0.77.0'), 'src/a.ts': 'a2\n' });
    assert.match(refusal(sha) ?? '', /^src\/a\.ts is neither a version file nor the changelog CHANGELOG\.md/);
  });
});
