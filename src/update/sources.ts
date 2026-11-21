/**
 * Where a newer teamrig or teamrig-pane is published (T2466): the host's plugin list, read through its plugin port,
 * names each install's version and marketplace, the port's marketplace list where that marketplace lives, and the
 * marketplace's `marketplace.json` the folder of each plugin in it, whose `.claude-plugin/plugin.json` holds the version
 * published. Plain parsers: a file of another shape reads as nothing, so the update notice stays quiet rather than wrong.
 */
import { isRecord } from '../core/guards.ts';
import { parseVersion } from '../core/release-version.ts';
import type { PluginInstall } from '../ports/host/index.ts';

/** The plugins the update notice tells of: teamrig's own, each from its own marketplace. */
export const TRACKED_PLUGINS: readonly string[] = ['teamrig', 'teamrig-pane'];

/** The file in a marketplace that lists its plugins. */
export const MARKETPLACE_FILE = '.claude-plugin/marketplace.json';
/** The file in a plugin's folder that holds its version. */
export const PLUGIN_FILE = '.claude-plugin/plugin.json';

/** An install of a tracked plugin, as the plugin list records it. */
export interface TrackedInstall {
  readonly plugin: string;
  readonly marketplace: string;
  readonly version: string;
}

function parsed(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

/**
 * The tracked plugins' installs among `installs` (the host's plugin list), one per plugin and marketplace: the one
 * that serves every project where there is one (what a tab outside a project's install runs), else the first listed.
 * An install with no marketplace or no release version is left out.
 */
export function trackedInstallsOf(installs: readonly PluginInstall[]): readonly TrackedInstall[] {
  const chosen = new Map<string, TrackedInstall & { readonly everywhere: boolean }>();
  for (const { key, plugin, marketplace, reach, version } of installs) {
    if (marketplace === '' || !TRACKED_PLUGINS.includes(plugin) || parseVersion(version) === undefined) {
      continue;
    }
    const everywhere = reach.kind === 'every project';
    const held = chosen.get(key);
    if (held === undefined || (everywhere && !held.everywhere)) {
      chosen.set(key, { plugin, marketplace, version, everywhere });
    }
  }
  return [...chosen.values()].map(({ plugin, marketplace, version }) => ({ plugin, marketplace, version }));
}

/**
 * The folder of `plugin` in a marketplace, relative to its root and with no `./` or trailing slash (`plugins/teamrig`;
 * `` for the root itself); undefined when the marketplace does not list it there, or names another kind of source.
 *
 * A `git-subdir` source (`{"source": "git-subdir", "url": ..., "path": "plugins/teamrig", "ref": "release"}`) installs
 * the folder `path` of another branch. Its folder is read here in the marketplace's own commit all the same: each
 * tracked plugin's release branch is a commit of its main with the build on top (tools/release/publish.ts), so main's
 * plugin.json names the released version. A release pull request raises main's copy minutes before its branch is
 * published; an update asked in those minutes finds the version it has, and the next check shows the band again.
 */
export function pluginFolderOf(marketplaceText: string, plugin: string): string | undefined {
  const marketplace = parsed(marketplaceText);
  const plugins = isRecord(marketplace) ? marketplace['plugins'] : undefined;
  if (!Array.isArray(plugins)) {
    return undefined;
  }
  for (const entry of plugins) {
    if (isRecord(entry) && entry['name'] === plugin) {
      const source = entry['source'];
      if (typeof source === 'string') {
        return source.startsWith('./') ? folderIn(source.slice(2)) : undefined;
      }
      const path = isRecord(source) && source['source'] === 'git-subdir' ? source['path'] : undefined;
      return typeof path === 'string' && path !== '' ? folderIn(path.replace(/^\.\//, '')) : undefined;
    }
  }
  return undefined;
}

/** A relative folder without its trailing slash; undefined for one that starts at the root, climbs out or uses `\`. */
function folderIn(path: string): string | undefined {
  return path.startsWith('/') || path.includes('\\') || path.split('/').includes('..') ? undefined : path.replace(/\/+$/, '');
}

/** The path of a plugin's plugin.json in its marketplace, given its folder there. */
export function pluginFilePath(folder: string): string {
  return folder === '' ? PLUGIN_FILE : `${folder}/${PLUGIN_FILE}`;
}

/** The release version a plugin.json names; undefined when it names none of MAJOR.MINOR.PATCH form. */
export function pluginVersionOf(pluginText: string): string | undefined {
  const plugin = parsed(pluginText);
  const version = isRecord(plugin) ? plugin['version'] : undefined;
  return typeof version === 'string' && parseVersion(version) !== undefined ? version : undefined;
}
