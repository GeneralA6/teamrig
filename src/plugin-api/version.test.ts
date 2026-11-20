import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, apiVersionNotice, isApiVersion } from './version.ts';

describe('the plugin API version', () => {
  it('is a plain semver version', () => {
    assert.equal(isApiVersion(API_VERSION), true);
    assert.equal(isApiVersion('1.4.0'), true);
    assert.equal(isApiVersion('1.4'), false);
    assert.equal(isApiVersion('v1.4.0'), false);
    assert.equal(isApiVersion('1.4.0-beta'), false);
  });

  it('takes an adapter built for the same major, whatever its minor and patch', () => {
    assert.equal(apiVersionNotice('2.0.0', '2.7.3'), undefined);
    assert.equal(apiVersionNotice('2.9.1', '2.0.0'), undefined);
    assert.equal(apiVersionNotice(API_VERSION, API_VERSION), undefined);
  });

  it('says why an adapter built for another major cannot load', () => {
    assert.equal(apiVersionNotice('1.9.0', '2.0.0'), 'it is built for plugin API 1.9.0 and this teamrig has 2.0.0: their major versions differ');
    assert.equal(apiVersionNotice('3.0.0', '2.0.0'), 'it is built for plugin API 3.0.0 and this teamrig has 2.0.0: their major versions differ');
  });

  it('says so when the declared version is no version', () => {
    assert.equal(apiVersionNotice('latest', '2.0.0'), 'its apiVersion "latest" is not a version like 2.0.0');
  });
});
