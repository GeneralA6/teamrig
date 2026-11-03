import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { appliesTo, INSTALLED_PLUGINS_FILE, installsOf, samePath } from '../core/installed-plugins.ts';
import type { SecretScanner } from '../core/secrets.ts';
import { jsonObjectOf } from '../doctor/settings-env.ts';
import type { HookOutputs } from './scan-hook-output.ts';
import { hookFindings, type SettingsFinding } from './scan-settings.ts';

/** Where plugins are found: Claude Code's configuration folder, and the project whose sessions run them. */
export interface PluginHookLocations {
  readonly claudeDir: string;
  readonly project: string;
}

/** A plugin's hooks file, with the object that holds its `hooks` as a settings file holds them. */
interface HooksSource {
  readonly path: string;
  readonly settings: JsonRecord;
}

async function jsonAt(files: Files, path: string): Promise<JsonRecord | undefined> {
  const text = await files.read(path);
  return text === undefined ? undefined : jsonObjectOf(text);
}

/** The settings files whose `enabledPlugins` turn a plugin on or off for the project, the one that wins last. */
function enablingFiles(at: PluginHookLocations): string[] {
  const project = join(at.project, '.claude');
  return [join(at.claudeDir, 'settings.json'), join(project, 'settings.json'), join(project, 'settings.local.json')];
}

/** Each plugin the settings files turn on (true) or off (false), as the last file to name it says. */
async function enabledPlugins(files: Files, at: PluginHookLocations): Promise<ReadonlyMap<string, boolean>> {
  const enabled = new Map<string, boolean>();
  for (const path of enablingFiles(at)) {
    const listed = (await jsonAt(files, path))?.['enabledPlugins'];
    for (const [key, on] of isRecord(listed) ? Object.entries(listed) : []) {
      if (typeof on === 'boolean') {
        enabled.set(key, on);
      }
    }
  }
  return enabled;
}

/** The hooks files a manifest's `hooks` names: one path, or a list of them. */
function namedFiles(hooks: unknown): string[] {
  if (typeof hooks === 'string') {
    return [hooks];
  }
  return Array.isArray(hooks) ? hooks.filter((path): path is string => typeof path === 'string') : [];
}

/**
 * An install's hooks: its `hooks/hooks.json`, each file its manifest's `hooks` names (relative to the install), each
 * read once, and the manifest itself when its `hooks` holds them inline. A file that is missing or not JSON adds none.
 */
async function hooksSources(files: Files, installPath: string): Promise<HooksSource[]> {
  const manifestPath = join(installPath, '.claude-plugin', 'plugin.json');
  const manifest = await jsonAt(files, manifestPath);
  const named = namedFiles(manifest?.['hooks']).map((path) => join(installPath, path));
  const paths = [join(installPath, 'hooks', 'hooks.json'), ...named].filter((path, index, all) => all.findIndex((other) => samePath(other, path)) === index);
  const read = await Promise.all(paths.map(async (path) => ({ path, settings: await jsonAt(files, path) })));
  const sources = read.flatMap(({ path, settings }): HooksSource[] => (settings === undefined ? [] : [{ path, settings }]));
  return manifest !== undefined && isRecord(manifest['hooks']) ? [...sources, { path: manifestPath, settings: manifest }] : sources;
}

/**
 * The context hooks of the plugins installed for `at.project` that the transcripts read (`hooks`) show printing into
 * the context, each named with its plugin and the hooks file that holds it. A plugin a settings file turns off is
 * skipped; one no file names counts as on, since only a hook that ran is a finding. One command a plugin lists under
 * several matchers, or two installs of one plugin list, is one finding. No plugin list, or one of another shape, finds
 * nothing. It only reads.
 */
export async function scanPluginHooks(files: Files, at: PluginHookLocations, hooks: HookOutputs, secrets: SecretScanner): Promise<SettingsFinding[]> {
  const text = await files.read(join(at.claudeDir, 'plugins', INSTALLED_PLUGINS_FILE));
  const installs = (text === undefined ? undefined : installsOf(text)) ?? [];
  const enabled = await enabledPlugins(files, at);
  const found = new Map<string, SettingsFinding>();
  for (const { key, install } of installs) {
    if (!appliesTo(install, at.project) || enabled.get(key) === false) {
      continue;
    }
    for (const source of await hooksSources(files, install.installPath)) {
      for (const finding of hookFindings(source.path, source.settings, hooks, secrets, key)) {
        if (!found.has(finding.what)) {
          found.set(finding.what, { ...finding, copies: 0 });
        }
      }
    }
  }
  return [...found.values()];
}
