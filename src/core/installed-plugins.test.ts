import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { InstallReach, PluginInstall } from '../ports/host/plugin.ts';
import { appliesTo, samePath } from './installed-plugins.ts';

const CACHE = 'C:\\Users\\me\\.claude\\plugins\\cache';

function install(reach: InstallReach): PluginInstall {
  return { key: 'teamrig@teamrig', plugin: 'teamrig', marketplace: 'teamrig', reach, installPath: `${CACHE}\\teamrig\\teamrig\\0.41.0`, version: '0.41.0', revision: 'aaa' };
}

describe('appliesTo', () => {
  it('takes an install for every project everywhere, one for a project in that project only, one of an unknown reach nowhere', () => {
    assert.equal(appliesTo(install({ kind: 'every project' }), 'D:\\work\\shop'), true);
    assert.equal(appliesTo(install({ kind: 'project', path: 'd:/work/shop' }), 'D:\\work\\shop'), true);
    assert.equal(appliesTo(install({ kind: 'project', path: 'D:\\work\\other' }), 'D:\\work\\shop'), false);
    assert.equal(appliesTo(install({ kind: 'unknown' }), 'D:\\work\\shop'), false);
  });
});

describe('samePath', () => {
  it('treats Windows paths alike whatever their case and slashes, and POSIX paths exactly', () => {
    assert.equal(samePath('D:\\Work\\Shop', 'd:/work/shop/'), true);
    assert.equal(samePath('\\\\server\\share\\shop', '//SERVER/share/shop'), true);
    assert.equal(samePath('D:\\work\\shop', 'D:\\work\\other'), false);
    assert.equal(samePath('C:/shop', '/shop'), false);
    assert.equal(samePath('/home/me/shop/', '/home/me/shop'), true);
    assert.equal(samePath('/home/me/shop', '/home/me/Shop'), false);
    assert.equal(samePath('/', '/'), true);
  });
});
