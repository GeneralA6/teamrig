import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { SecretScanner } from '../core/secrets.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { hookOutputKey, type HookOutputs } from './scan-hook-output.ts';
import { scanPluginHooks, type PluginHookLocations } from './scan-plugin-hooks.ts';

const CLAUDE_DIR = join(resolve('/', 'u'), '.claude');
const PROJECT = resolve('/', 'work', 'app');
const OTHER_PROJECT = resolve('/', 'work', 'other');
const AT: PluginHookLocations = { claudeDir: CLAUDE_DIR, project: PROJECT };
const PLUGIN_LIST = join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');
const KIT = join(CLAUDE_DIR, 'plugins', 'cache', 'mk', 'kit', '1.0.0');
const KIT_HOOKS = join(KIT, 'hooks', 'hooks.json');
const USER_SETTINGS = join(CLAUDE_DIR, 'settings.json');
const LOCAL_SETTINGS = join(PROJECT, '.claude', 'settings.local.json');
const SECRETS = new SecretScanner([]);

/** The line a transcript records for kit's exec-form start hook: its command and args, the plugin root unexpanded. */
const START = 'node ${CLAUDE_PLUGIN_ROOT}/main.js hook start';

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function pluginList(installs: Readonly<Record<string, readonly object[]>>): string {
  return json({ version: 2, plugins: installs });
}

const USER_INSTALL = { scope: 'user', installPath: KIT, version: '1.0.0' };

/** Kit's start hook under two matchers, a hook that never printed and one that never ran. */
const KIT_HOOKS_FILE = json({
  description: 'kit',
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/main.js', 'hook', 'start'] }] },
      { matcher: 'clear', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/main.js', 'hook', 'start'] }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/title.js' }, { type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/never.js' }] }],
  },
});

const HOOKS: HookOutputs = new Map([
  [hookOutputKey('SessionStart', START), { runs: 2, printed: 2, chars: 9_000 }],
  [hookOutputKey('UserPromptSubmit', 'node ${CLAUDE_PLUGIN_ROOT}/title.js'), { runs: 5, printed: 0, chars: 0 }],
]);

const START_FINDING = /^SessionStart hook "node \$\{CLAUDE_PLUGIN_ROOT\}\/main\.js hook start" of plugin kit@mk: printed ~/;

describe('scanPluginHooks', () => {
  it('names a plugin hook that printed into the context, with its plugin and hooks file, once over its matchers', async () => {
    const files = new MemoryFiles({ [PLUGIN_LIST]: pluginList({ 'kit@mk': [USER_INSTALL] }), [KIT_HOOKS]: KIT_HOOKS_FILE });
    const found = await scanPluginHooks(files, AT, HOOKS, SECRETS);
    assert.deepEqual(
      found.map((finding) => [finding.kind, finding.path, finding.copies]),
      [['context-hook', KIT_HOOKS, 0]],
    );
    assert.match(found[0]?.what ?? '', START_FINDING);
  });

  it('names one finding for two installs of one plugin that apply', async () => {
    const project = { scope: 'project', installPath: KIT, version: '1.0.0', projectPath: PROJECT };
    const files = new MemoryFiles({ [PLUGIN_LIST]: pluginList({ 'kit@mk': [USER_INSTALL, project] }), [KIT_HOOKS]: KIT_HOOKS_FILE });
    assert.equal((await scanPluginHooks(files, AT, HOOKS, SECRETS)).length, 1);
  });

  it('skips a plugin installed for another project', async () => {
    const elsewhere = { scope: 'local', installPath: KIT, version: '1.0.0', projectPath: OTHER_PROJECT };
    const files = new MemoryFiles({ [PLUGIN_LIST]: pluginList({ 'kit@mk': [elsewhere] }), [KIT_HOOKS]: KIT_HOOKS_FILE });
    assert.deepEqual(await scanPluginHooks(files, AT, HOOKS, SECRETS), []);
  });

  it('skips a plugin the last settings file to name it turns off, and keeps one it turns back on', async () => {
    const list = pluginList({ 'kit@mk': [USER_INSTALL] });
    const off = new MemoryFiles({
      [PLUGIN_LIST]: list,
      [KIT_HOOKS]: KIT_HOOKS_FILE,
      [USER_SETTINGS]: json({ enabledPlugins: { 'kit@mk': true } }),
      [LOCAL_SETTINGS]: json({ enabledPlugins: { 'kit@mk': false } }),
    });
    assert.deepEqual(await scanPluginHooks(off, AT, HOOKS, SECRETS), []);
    const on = new MemoryFiles({
      [PLUGIN_LIST]: list,
      [KIT_HOOKS]: KIT_HOOKS_FILE,
      [USER_SETTINGS]: json({ enabledPlugins: { 'kit@mk': false } }),
      [LOCAL_SETTINGS]: json({ enabledPlugins: { 'kit@mk': true, 'other@mk': 'yes' } }),
    });
    assert.equal((await scanPluginHooks(on, AT, HOOKS, SECRETS)).length, 1);
  });

  it('reads the hooks files a manifest names, each once, and hooks a manifest holds inline', async () => {
    const extra = join(KIT, 'extra', 'hooks.json');
    const inline = join(CLAUDE_DIR, 'plugins', 'cache', 'mk', 'tool', '2.0.0');
    const inlineManifest = join(inline, '.claude-plugin', 'plugin.json');
    const files = new MemoryFiles({
      [PLUGIN_LIST]: pluginList({ 'kit@mk': [USER_INSTALL], 'tool@mk': [{ scope: 'user', installPath: inline, version: '2.0.0' }] }),
      [join(KIT, '.claude-plugin', 'plugin.json')]: json({ name: 'kit', hooks: ['./hooks/hooks.json', './extra/hooks.json', 42] }),
      [KIT_HOOKS]: json({ hooks: {} }),
      [extra]: KIT_HOOKS_FILE,
      [inlineManifest]: json({ name: 'tool', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'tool remind' }] }] } }),
    });
    const hooks: HookOutputs = new Map([...HOOKS, [hookOutputKey('UserPromptSubmit', 'tool remind'), { runs: 4, printed: 4, chars: 800 }]]);
    const found = await scanPluginHooks(files, AT, hooks, SECRETS);
    assert.deepEqual(
      found.map((finding) => finding.path),
      [extra, inlineManifest],
    );
    assert.match(found[1]?.what ?? '', /^UserPromptSubmit hook "tool remind" of plugin tool@mk: printed ~200 chars/);
  });

  it('reads a manifest naming one hooks file by a single path', async () => {
    const files = new MemoryFiles({
      [PLUGIN_LIST]: pluginList({ 'kit@mk': [USER_INSTALL] }),
      [join(KIT, '.claude-plugin', 'plugin.json')]: json({ name: 'kit', hooks: './extra.json' }),
      [join(KIT, 'extra.json')]: KIT_HOOKS_FILE,
    });
    assert.deepEqual(
      (await scanPluginHooks(files, AT, HOOKS, SECRETS)).map((finding) => finding.path),
      [join(KIT, 'extra.json')],
    );
  });

  it('finds nothing with no plugin list, a list of another shape, or a hooks file that is not JSON', async () => {
    assert.deepEqual(await scanPluginHooks(new MemoryFiles({}), AT, HOOKS, SECRETS), []);
    assert.deepEqual(await scanPluginHooks(new MemoryFiles({ [PLUGIN_LIST]: json({ plugins: { 'kit@mk': 'bad' } }) }), AT, HOOKS, SECRETS), []);
    const notJson = new MemoryFiles({ [PLUGIN_LIST]: pluginList({ 'kit@mk': [USER_INSTALL] }), [KIT_HOOKS]: '{ not json' });
    assert.deepEqual(await scanPluginHooks(notJson, AT, HOOKS, SECRETS), []);
  });
});
