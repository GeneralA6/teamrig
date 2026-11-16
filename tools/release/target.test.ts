import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MANIFEST, outputLines, releaseTarget } from './target.ts';

const SHA = 'a'.repeat(40);
const manifest = (version: unknown): string => JSON.stringify({ name: 'teamrig', version });

describe('releaseTarget', () => {
  it("takes the commit's plugin.json version on a run by hand", () => {
    assert.deepEqual(releaseTarget(manifest('0.447.1'), SHA, ''), { version: '0.447.1', sha: SHA });
  });

  it('takes it when it is the version release-please released', () => {
    assert.deepEqual(releaseTarget(manifest('0.448.0'), SHA, '0.448.0'), { version: '0.448.0', sha: SHA });
  });

  it('refuses a commit whose plugin.json holds another version than the release', () => {
    assert.throws(() => releaseTarget(manifest('0.447.1'), SHA, '0.448.0'), new Error(`${MANIFEST} holds 0.447.1, but the release is 0.448.0`));
  });

  it('refuses a manifest with no plain version, and a short sha', () => {
    assert.throws(() => releaseTarget(manifest('0.448.0-rc.1'), SHA, ''), new Error(`${MANIFEST} holds no MAJOR.MINOR.PATCH version`));
    assert.throws(() => releaseTarget(manifest(448), SHA, ''), new Error(`${MANIFEST} holds no MAJOR.MINOR.PATCH version`));
    assert.throws(() => releaseTarget('[]', SHA, ''), new Error(`${MANIFEST} holds no MAJOR.MINOR.PATCH version`));
    assert.throws(() => releaseTarget(manifest('0.448.0'), 'abc1234', ''), new Error('abc1234 is not a full commit sha'));
  });
});

describe('outputLines', () => {
  it('writes the version and the sha as step outputs', () => {
    assert.equal(outputLines({ version: '0.448.0', sha: SHA }), `version=0.448.0\nsha=${SHA}\n`);
  });
});
