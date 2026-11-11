import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { marketplaceSourceOf, pluginFilePath, pluginFolderOf, pluginVersionOf, trackedInstallsOf } from './sources.ts';

function pluginList(plugins: Readonly<Record<string, readonly Readonly<Record<string, string>>[]>>): string {
  return JSON.stringify({ version: 2, plugins });
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

  it('leaves out an install with no release version, and reads a list of another shape as none', () => {
    assert.deepEqual(trackedInstallsOf(pluginList({ 'teamrig@kit': [user('main')] })), []);
    assert.deepEqual(trackedInstallsOf('{"plugins": []}'), []);
    assert.deepEqual(trackedInstallsOf('not json'), []);
  });
});

describe('marketplaceSourceOf', () => {
  const known = JSON.stringify({
    kit: { source: { source: 'github', repo: 'owner/kit' }, installLocation: '/claude/plugins/marketplaces/kit' },
    local: { source: { source: 'directory', path: '/work/kit' }, installLocation: '/work/kit' },
    broken: { source: { source: 'github', repo: 'owner/broken' } },
  });

  it('reads a cloned marketplace as its clone, and a directory one as its folder', () => {
    assert.deepEqual(marketplaceSourceOf(known, 'kit'), { kind: 'clone', installLocation: '/claude/plugins/marketplaces/kit' });
    assert.deepEqual(marketplaceSourceOf(known, 'local'), { kind: 'directory', path: '/work/kit' });
  });

  it('reads an unlisted marketplace, one with no location and a list of another shape as none', () => {
    assert.equal(marketplaceSourceOf(known, 'missing'), undefined);
    assert.equal(marketplaceSourceOf(known, 'broken'), undefined);
    assert.equal(marketplaceSourceOf('[]', 'kit'), undefined);
    assert.equal(marketplaceSourceOf('', 'kit'), undefined);
  });
});

describe('pluginFolderOf', () => {
  const marketplace = (source: unknown): string => JSON.stringify({ name: 'kit', plugins: [{ name: 'other', source: './x' }, { name: 'teamrig', source }] });

  it('reads the plugin folder a relative source names, without its ./ and trailing slash', () => {
    assert.equal(pluginFolderOf(marketplace('./plugins/teamrig'), 'teamrig'), 'plugins/teamrig');
    assert.equal(pluginFolderOf(marketplace('./plugins/teamrig/'), 'teamrig'), 'plugins/teamrig');
    assert.equal(pluginFolderOf(marketplace('./'), 'teamrig'), '');
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
