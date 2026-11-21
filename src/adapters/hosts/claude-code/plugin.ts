import type { HostPlugin, InstallReach, MarketplaceSource, PluginInstall } from '../../../plugin-api/index.ts';

/**
 * Claude Code's plugin store: `installed_plugins.json` (version 2) and `known_marketplaces.json` in its `plugins`
 * folder, the cache at `<config>/plugins/cache/<marketplace>/<plugin>/<version>` its installs run from, and
 * `claude plugin` for an update. The plugin's mod (`hooks/register.ts`) imports this file inside Claude Code, which
 * runs it without Node, so it imports nothing at run time: the plugin api's own guards bring Node modules with them.
 */

const LIST_FILE = 'installed_plugins.json';
const MARKETPLACES_FILE = 'known_marketplaces.json';

type Fields = Readonly<Record<string, unknown>>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalText(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function parsed(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

/** `user` serves every project; `project` and `local` the one at `projectPath`; any other scope none teamrig knows. */
function reachOf(scope: string, projectPath: string | undefined): InstallReach {
  if (scope === 'user') {
    return { kind: 'every project' };
  }
  const forAProject = scope === 'project' || scope === 'local';
  return forAProject && projectPath !== undefined ? { kind: 'project', path: projectPath } : { kind: 'unknown' };
}

function installOf(key: string, entry: unknown): PluginInstall | undefined {
  if (!isFields(entry)) {
    return undefined;
  }
  const { scope, installPath, version, gitCommitSha, projectPath } = entry;
  if (typeof scope !== 'string' || typeof installPath !== 'string') {
    return undefined;
  }
  if (!isOptionalText(version) || !isOptionalText(gitCommitSha) || !isOptionalText(projectPath)) {
    return undefined;
  }
  const at = key.lastIndexOf('@');
  const plugin = at < 0 ? key : key.slice(0, at);
  const marketplace = at < 0 ? '' : key.slice(at + 1);
  return { key, plugin, marketplace, reach: reachOf(scope, projectPath), installPath, version: version ?? '', revision: gitCommitSha ?? '' };
}

/** Each install under its `<plugin>@<marketplace>` key; undefined when any part is of another shape. */
function installs(listText: string): readonly PluginInstall[] | undefined {
  const file = parsed(listText);
  const plugins = isFields(file) ? file['plugins'] : undefined;
  if (!isFields(plugins)) {
    return undefined;
  }
  const listed: PluginInstall[] = [];
  for (const [key, entries] of Object.entries(plugins)) {
    if (!Array.isArray(entries)) {
      return undefined;
    }
    for (const entry of entries) {
      const install = installOf(key, entry);
      if (install === undefined) {
        return undefined;
      }
      listed.push(install);
    }
  }
  return listed;
}

/** A `directory` source is read in place; `github`, `git` and `url` ones are cloned to `installLocation`. */
function marketplaceSource(marketplacesText: string, name: string): MarketplaceSource | undefined {
  const known = parsed(marketplacesText);
  const entry = isFields(known) ? known[name] : undefined;
  if (!isFields(entry)) {
    return undefined;
  }
  const { source, installLocation } = entry;
  if (isFields(source) && source['source'] === 'directory') {
    const path = source['path'];
    return typeof path === 'string' && path !== '' ? { kind: 'directory', path } : undefined;
  }
  return typeof installLocation === 'string' && installLocation !== '' ? { kind: 'clone', installLocation } : undefined;
}

function partsOf(path: string): string[] {
  const parts = path.split(/[\\/]/);
  while (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

/**
 * Read from the plugin's own root, so the folder follows the configuration folder this Claude Code really uses
 * (`CLAUDE_CONFIG_DIR` too) with no environment read. A plugin run with `--plugin-dir` or from a marketplace that is a
 * local folder has none.
 */
function pluginsFolderOf(pluginRoot: string): string | undefined {
  const parts = partsOf(pluginRoot);
  const count = parts.length;
  if (count < 6 || parts[count - 5] !== 'plugins' || parts[count - 4] !== 'cache') {
    return undefined;
  }
  return parts.slice(0, count - 4).join('/');
}

/** Claude Code adds this folder to its Bash tool's PATH while the plugin is enabled. */
function isCacheBin(folder: string): boolean {
  const parts = partsOf(folder);
  return parts.at(-1) === 'bin' && pluginsFolderOf(parts.slice(0, -1).join('/')) !== undefined;
}

/** The marketplace first, so Claude Code sees the newest version, then the plugin: the way `/plugin` lands it. */
function updateSteps(plugin: string, marketplace: string): readonly (readonly string[])[] {
  return [
    ['plugin', 'marketplace', 'update', marketplace],
    ['plugin', 'update', `${plugin}@${marketplace}`],
  ];
}

export const hostPlugin: HostPlugin = {
  listFile: LIST_FILE,
  marketplacesFile: MARKETPLACES_FILE,
  installs,
  marketplaceSource,
  pluginsFolderOf,
  isCacheBin,
  updateSteps,
};
