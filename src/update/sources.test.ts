import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginInstall } from '../ports/host/index.ts';
import { shippedPlugin } from '../testing/shipped-plugin.ts';
import { pluginFilePath, pluginFolderOf, pluginVersionOf, trackedInstallsOf } from './sources.ts';

const PLUGIN = shippedPlugin();

/** The installs the shipped host reads from a plugin list holding `plugins`; none for a list of another shape. */
function pluginList(plugins: Readonly<Record<string, readonly Readonly<Record<string, string>>[]>> | string): readonly PluginInstall[] {
  return PLUGIN.installs(typeof plugins === 'string' ? plugins : JSON.stringify({ version: 2, plugins })) ?? [];
}

const user = (version: string): Readonly<Record<string, string>> => ({ scope: 'user', installPath: `/cache/${version}`, version });
const project = (version: string): Readonly<Record<string, string>> => ({ scope: 'project', installPath: `/cache/${version}`, version, projectPath: '/app' });

describe('trackedInstallsOf', () => {
  it('reads teamrig and teamrig-pane installs with their marketplaces, leaving other plugins out', () => {
    const text = pluginList({ 'teamrig@kit': [user('0.3.0')], 'teamrig-pane@pane': [user('0.7.1')], 'other@kit': [user('1.0.0')] });
    assert.deepEqual(trackedInstallsOf(text), [
      { plugin: 'teamrig', marketplace: 'kit', version: '0.3.0' },
      { plugin: 'teamrig-pane', marketplace: 'pane', version: '0.7.1' },
    ]);
  });

  it('takes the user-scope install over a project one listed first', () => {
    const text = pluginList({ 'teamrig@kit': [project('0.2.0'), user('0.3.0')] });
    assert.deepEqual(trackedInstallsOf(text), [{ plugin: 'teamrig', marketplace: 'kit', version: '0.3.0' }]);
  });

  it('takes the first install when none is user-scope', () => {
    const text = pluginList({ 'teamrig@kit': [project('0.2.0'), project('0.4.0')] });
    assert.deepEqual(trackedInstallsOf(text), [{ plugin: 'teamrig', marketplace: 'kit', version: '0.2.0' }]);
  });

  it('leaves out an install with no release version or no marketplace, and reads a list of another shape as none', () => {
    assert.deepEqual(trackedInstallsOf(pluginList({ 'teamrig@kit': [user('main')], teamrig: [user('0.3.0')] })), []);
    assert.deepEqual(trackedInstallsOf(pluginList('{"plugins": []}')), []);
    assert.deepEqual(trackedInstallsOf(pluginList('not json')), []);
  });
});

describe('pluginFolderOf', () => {
  const marketplace = (source: unknown): string => JSON.stringify({ name: 'kit', plugins: [{ name: 'other', source: './x' }, { name: 'teamrig', source }] });

  it('reads the plugin folder a relative source names, without its ./ and trailing slash', () => {
    assert.equal(pluginFolderOf(marketplace('./plugins/teamrig'), 'teamrig'), 'plugins/teamrig');
    assert.equal(pluginFolderOf(marketplace('./plugins/teamrig/'), 'teamrig'), 'plugins/teamrig');
    assert.equal(pluginFolderOf(marketplace('./'), 'teamrig'), '');
  });

  it("reads a git-subdir source's path, which main holds as its release branch does (T4355)", () => {
    const subdir = (path: unknown): string => marketplace({ source: 'git-subdir', url: 'owner/teamrig', path, ref: 'release' });
    assert.equal(pluginFolderOf(subdir('plugins/teamrig'), 'teamrig'), 'plugins/teamrig');
    assert.equal(pluginFolderOf(subdir('./plugins/teamrig/'), 'teamrig'), 'plugins/teamrig');
    for (const path of ['', '/abs/teamrig', 'plugins/../../elsewhere', 'plugins\\teamrig', 3]) {
      assert.equal(pluginFolderOf(subdir(path), 'teamrig'), undefined, JSON.stringify(path));
    }
  });

  it('reads no folder for another kind of source, a path that climbs out, or an unlisted plugin', () => {
    assert.equal(pluginFolderOf(marketplace({ source: 'github', repo: 'owner/teamrig' }), 'teamrig'), undefined);
    assert.equal(pluginFolderOf(marketplace('./../elsewhere'), 'teamrig'), undefined);
    assert.equal(pluginFolderOf(marketplace('/abs/teamrig'), 'teamrig'), undefined);
    assert.equal(pluginFolderOf(marketplace('./plugins/teamrig'), 'teamrig-pane'), undefined);
    assert.equal(pluginFolderOf('{}', 'teamrig'), undefined);
  });
});

describe('pluginFilePath and pluginVersionOf', () => {
  it('names the plugin.json in a folder or at the root', () => {
    assert.equal(pluginFilePath('plugins/teamrig'), 'plugins/teamrig/.claude-plugin/plugin.json');
    assert.equal(pluginFilePath(''), '.claude-plugin/plugin.json');
  });

  it('reads a release version, and nothing else', () => {
    assert.equal(pluginVersionOf('{"name": "teamrig", "version": "0.333.0"}'), '0.333.0');
    assert.equal(pluginVersionOf('{"version": "0.333.0-beta"}'), undefined);
    assert.equal(pluginVersionOf('{"version": 3}'), undefined);
    assert.equal(pluginVersionOf('nope'), undefined);
  });
});
