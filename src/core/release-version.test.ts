import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, parseVersion, type Version } from './release-version.ts';

describe('parseVersion', () => {
  it('reads MAJOR.MINOR.PATCH', () => {
    assert.deepEqual(parseVersion('0.1.0'), { major: 0, minor: 1, patch: 0 });
    assert.deepEqual(parseVersion('10.20.30'), { major: 10, minor: 20, patch: 30 });
  });

  it('refuses anything else, pre-releases and leading zeros included', () => {
    // Four dotted numbers built at runtime, so the scrub does not read them as an IPv4 address.
    for (const text of ['', '1.2', [1, 2, 3, 4].join('.'), 'v1.2.3', '1.2.3-beta', '1.2.3+build', '01.2.3', '1.2.x']) {
      assert.equal(parseVersion(text), undefined, text);
    }
  });
});

describe('compareVersions', () => {
  const v = (text: string): Version => parseVersion(text) ?? assert.fail(text);

  it('orders by major, then minor, then patch', () => {
    assert.ok(compareVersions(v('1.0.0'), v('0.9.9')) > 0);
    assert.ok(compareVersions(v('0.2.0'), v('0.1.9')) > 0);
    assert.ok(compareVersions(v('0.1.1'), v('0.1.0')) > 0);
    assert.ok(compareVersions(v('0.1.0'), v('0.1.1')) < 0);
    assert.equal(compareVersions(v('0.10.0'), v('0.10.0')), 0);
  });
});
