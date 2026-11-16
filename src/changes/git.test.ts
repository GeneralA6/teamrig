import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMMIT_FORMAT, logArgs, parseCommits, parseReleaseCommits, parseReleaseTags, releaseIndexOf, releaseVersionOf } from './git.ts';

const R = '\x1e';
const F = '\x1f';

describe('releaseVersionOf', () => {
  it('reads the version a release commit names, in each way projects write one', () => {
    assert.equal(releaseVersionOf('plugin: version 0.447.0, a ship tool runs only from main (T3223)'), '0.447.0');
    assert.equal(releaseVersionOf('chore(release): 1.2.3'), '1.2.3');
    assert.equal(releaseVersionOf('release v2.0.0-rc.1'), '2.0.0-rc.1');
    assert.equal(releaseVersionOf('chore: bump version to 3.4.5'), '3.4.5');
    assert.equal(releaseVersionOf('v1.0.0'), '1.0.0');
  });

  it('reads no version from a commit that only mentions one', () => {
    assert.equal(releaseVersionOf('fix(ship): refuse a ship tool older than 0.447.0'), undefined);
    assert.equal(releaseVersionOf('docs: the version 0.447.0.1 scheme'), undefined);
    assert.equal(releaseVersionOf('build: rebuild the plugin dist'), undefined);
  });
});

describe('parseCommits', () => {
  it('reads each record with its files, in UTC, and skips an empty one', () => {
    const text = `${R}aaa${F}2026-11-16T22:41:00+02:00${F}feat: one${F}why it is${F}\nsrc/a.ts\nsrc/b.ts\n${R}bbb${F}2026-11-16T10:00:00Z${F}fix: two${F}${F}\n`;
    assert.deepEqual(parseCommits(text), [
      { sha: 'aaa', at: '2026-11-16T20:41:00.000Z', subject: 'feat: one', body: 'why it is', files: ['src/a.ts', 'src/b.ts'] },
      { sha: 'bbb', at: '2026-11-16T10:00:00.000Z', subject: 'fix: two', body: '', files: [] },
    ]);
    assert.deepEqual(parseCommits(''), []);
  });

  it('matches the format logArgs asks git for', () => {
    assert.ok(logArgs({ since: { version: undefined, at: undefined, ref: undefined }, until: undefined, paths: [] }).includes(`--format=${COMMIT_FORMAT}`));
  });
});

describe('the release index', () => {
  it('reads release commits and version tags, and leaves out the rest', () => {
    assert.deepEqual(parseReleaseCommits(`c1${F}2026-11-16T12:00:00Z${F}plugin: version 0.2.0, x\nc2${F}2026-11-15T12:00:00Z${F}feat: y\n`), [
      { version: '0.2.0', at: '2026-11-16T12:00:00.000Z', sha: 'c1' },
    ]);
    assert.deepEqual(parseReleaseTags(`v0.1.0${F}2026-11-14T12:00:00Z${F}t1\nnightly${F}2026-11-14T12:00:00Z${F}t2\nv0.0.9${F}${F}t3\n`), [
      { version: '0.1.0', at: '2026-11-14T12:00:00.000Z', sha: 't1' },
    ]);
  });

  it('lets a tag win over a commit naming its version, and sorts newest first', () => {
    const tags = [{ version: '0.1.0', at: '2026-11-14T12:00:00Z', sha: 'tag' }];
    const commits = [
      { version: '0.2.0', at: '2026-11-16T12:00:00Z', sha: 'c2' },
      { version: '0.1.0', at: '2026-11-14T11:00:00Z', sha: 'c1' },
    ];
    assert.deepEqual(
      releaseIndexOf(tags, commits).map((release) => release.sha),
      ['c2', 'tag'],
    );
  });
});

describe('logArgs', () => {
  const at = (iso: string) => ({ version: undefined, at: iso, ref: undefined });

  it('logs by commit when the range names a release, up to HEAD with no end', () => {
    const args = logArgs({ since: { version: '0.1.0', at: '2026-11-14T12:00:00Z', ref: 'c1' }, until: undefined, paths: ['src/open/'] });
    assert.deepEqual(args.slice(args.indexOf('--end-of-options')), ['--end-of-options', 'c1..HEAD', '--', 'src/open/']);
    assert.ok(!args.some((arg) => arg.startsWith('--since=')));
  });

  it('logs by time when the range names a day, and ends at a release commit when one is given', () => {
    const args = logArgs({ since: at('2026-11-14T00:00:00Z'), until: { version: '0.2.0', at: '2026-11-16T12:00:00Z', ref: 'c2' }, paths: [] });
    assert.ok(args.includes('--since=2026-11-14T00:00:00Z'));
    assert.ok(!args.some((arg) => arg.startsWith('--until=')));
    assert.deepEqual(args.slice(args.indexOf('--end-of-options')), ['--end-of-options', 'c2', '--']);
  });

  it('bounds both ends by time when neither names a release', () => {
    const args = logArgs({ since: at('2026-11-14T00:00:00Z'), until: at('2026-11-15T00:00:00Z'), paths: [] });
    assert.ok(args.includes('--until=2026-11-15T00:00:00Z'));
    assert.ok(args.includes('--no-merges'));
  });
});
