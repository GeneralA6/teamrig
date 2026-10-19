import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appliesTo, installedPluginsFileOf, installsOf, isPluginCacheBin, samePath, type Install } from './installed-plugins.ts';

const CACHE = 'C:\\Users\\me\\.claude\\plugins\\cache';

function install(scope: string, projectPath?: string): Install {
  return { scope, installPath: `${CACHE}\\teamrig\\teamrig\\0.41.0`, version: '0.41.0', gitCommitSha: 'aaa', projectPath };
}

describe('installsOf', () => {
  it('reads every install under its plugin key, in order, with a missing version or commit as empty', () => {
    const text = JSON.stringify({
      version: 2,
      plugins: {
        'teamrig@teamrig': [{ scope: 'user', installPath: 'C:\\cache\\teamrig\\teamrig\\0.85.0', version: '0.85.0', gitCommitSha: 'abc' }],
        'p@m': [{ scope: 'project', installPath: '/cache/m/p/1.0.0', projectPath: '/work/shop' }],
      },
    });
    assert.deepEqual(installsOf(text), [
      {
        key: 'teamrig@teamrig',
        install: { scope: 'user', installPath: 'C:\\cache\\teamrig\\teamrig\\0.85.0', version: '0.85.0', gitCommitSha: 'abc', projectPath: undefined },
      },
      { key: 'p@m', install: { scope: 'project', installPath: '/cache/m/p/1.0.0', version: '', gitCommitSha: '', projectPath: '/work/shop' } },
    ]);
    assert.deepEqual(installsOf('{"version": 2, "plugins": {}}'), []);
  });

  it('reads a half-written file, another shape or one install of another shape as none', () => {
    for (const text of [
      '',
      '{"version": 2, "plu',
      '[]',
      '{"version": 2}',
      '{"plugins": []}',
      '{"plugins": {"p@m": {}}}',
      '{"plugins": {"p@m": [{"scope": "user"}]}}',
      '{"plugins": {"p@m": [{"scope": "user", "installPath": "/x", "version": 2}]}}',
    ]) {
      assert.equal(installsOf(text), undefined, text);
    }
  });
});

describe('appliesTo', () => {
  it('takes a user install everywhere and a project or local one in its project only', () => {
    assert.equal(appliesTo(install('user'), 'D:\\work\\shop'), true);
    assert.equal(appliesTo(install('project', 'd:/work/shop'), 'D:\\work\\shop'), true);
    assert.equal(appliesTo(install('local', 'D:\\work\\shop'), 'D:\\work\\shop'), true);
    assert.equal(appliesTo(install('project', 'D:\\work\\other'), 'D:\\work\\shop'), false);
    assert.equal(appliesTo(install('project'), 'D:\\work\\shop'), false);
    assert.equal(appliesTo(install('managed', 'D:\\work\\shop'), 'D:\\work\\shop'), false);
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

describe('installedPluginsFileOf', () => {
  it('finds installed_plugins.json beside the cache a plugin runs from', () => {
    assert.equal(installedPluginsFileOf(`${CACHE}\\teamrig\\teamrig\\0.41.0`), 'C:/Users/me/.claude/plugins/installed_plugins.json');
    assert.equal(
      installedPluginsFileOf('/home/me/.config/claude/plugins/cache/teamrig/teamrig/0.41.0/'),
      '/home/me/.config/claude/plugins/installed_plugins.json',
    );
  });

  it('finds none for a plugin run from anywhere else', () => {
    for (const root of ['D:\\src\\teamrig\\plugins\\teamrig', '/home/me/plugins/teamrig/0.41.0', 'plugins/cache/m/p/1', '']) {
      assert.equal(installedPluginsFileOf(root), undefined, root);
    }
  });
});

describe('isPluginCacheBin', () => {
  it("knows a cached install's bin folder, either slash, a trailing one too, and a moved configuration folder", () => {
    for (const folder of [
      'C:\\Users\\me\\.claude\\plugins\\cache\\teamrig\\teamrig\\0.75.0\\bin',
      'C:\\Users\\me\\.claude\\plugins\\cache\\teamrig\\teamrig\\0.75.0\\bin\\',
      '/c/Users/me/.claude/plugins/cache/teamrig/teamrig/0.85.1/bin',
      '/srv/claude-config/plugins/cache/tools/lint/1.2.0/bin',
    ]) {
      assert.equal(isPluginCacheBin(folder), true, folder);
    }
  });

  it('leaves every other folder alone: a checkout, an install folder itself, another folder in it, a short path', () => {
    for (const folder of [
      'D:\\src\\teamrig\\plugins\\teamrig\\bin',
      'C:\\Users\\me\\.claude\\plugins\\cache\\teamrig\\teamrig\\0.75.0',
      'C:\\Users\\me\\.claude\\plugins\\cache\\teamrig\\teamrig\\0.75.0\\dist',
      '/c/Users/me/.claude/plugins/cache/teamrig/teamrig/bin',
      'plugins/cache/m/p/1/bin',
      '/usr/bin',
      '',
    ]) {
      assert.equal(isPluginCacheBin(folder), false, folder);
    }
  });
});
