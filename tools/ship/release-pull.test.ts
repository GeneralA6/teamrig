import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { TempRepo } from '../lib/temp-repo.ts';
import { releaseRefusal } from './release-pull.ts';
import type { ReleasePull } from './repos.ts';
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
    release('0.2.0');
    const sha = commitFiles('feat: slipped in', { 'src/a.ts': 'a, changed\n' });
    assert.match(refusal(sha) ?? '', /^src\/a\.ts is neither a version file nor the changelog CHANGELOG\.md/);
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

  it('refuses a changelog made executable', () => {
    release('0.2.0');
    repo.git('update-index', '--chmod=+x', CHANGELOG);
    repo.git('commit', '-q', '-m', 'chore: mode');
    const sha = repo.git('rev-parse', 'HEAD').trim();
    assert.equal(refusal(sha), `${CHANGELOG} is the changelog the release pull request may only add lines to, but its change is M 100644 to 100755`);
  });

  it('refuses a deleted version file', () => {
    commitFiles('chore(main): release 0.2.0', { [PLUGIN]: plugin('0.2.0'), [VERSION_TS]: versionTs('0.2.0'), [CHANGELOG]: notesWith('0.2.0') });
    repo.git('rm', '-q', RELEASE_MANIFEST);
    repo.git('commit', '-q', '-m', 'chore: drop');
    const sha = repo.git('rev-parse', 'HEAD').trim();
    assert.equal(refusal(sha), `${RELEASE_MANIFEST} is a version file the release pull request must only edit, but its change is D 100644 to 000000`);
  });

  it('refuses a head that changes nothing over main', () => {
    const sha = repo.git('rev-parse', 'HEAD').trim();
    assert.equal(refusal(sha), `the release pull request's head ${sha} changes nothing over main`);
  });
});
