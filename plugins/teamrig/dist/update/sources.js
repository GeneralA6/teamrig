/**
 * Where a newer teamrig or teamrig-pane is published, read from Claude Code's own plugin files (T2466): the plugin list
 * (`installed_plugins.json`) names each install's version and marketplace, the marketplace list
 * (`known_marketplaces.json`) where that marketplace lives, and the marketplace's `marketplace.json` the folder of each
 * plugin in it, whose `.claude-plugin/plugin.json` holds the version published. Plain parsers: a file of another shape
 * reads as nothing, so the update notice stays quiet rather than wrong.
 */
import { isRecord } from "../core/guards.js";
import { installsOf } from "../core/installed-plugins.js";
import { parseVersion } from "../core/release-version.js";
/** The plugins the update notice tells of: teamrig's own, each from its own marketplace. */
export const TRACKED_PLUGINS = ['teamrig', 'teamrig-pane'];
/** The file in a marketplace that lists its plugins. */
export const MARKETPLACE_FILE = '.claude-plugin/marketplace.json';
/** The file in a plugin's folder that holds its version. */
export const PLUGIN_FILE = '.claude-plugin/plugin.json';
function parsed(text) {
    try {
        const value = JSON.parse(text);
        return value;
    }
    catch {
        return undefined;
    }
}
/**
 * The tracked plugins' installs, one per plugin and marketplace: the user-scope one where there is one (what a tab
 * outside a project-scoped install runs), else the first listed. None for a list of another shape.
 */
export function trackedInstallsOf(installedText) {
    const listed = installsOf(installedText) ?? [];
    const chosen = new Map();
    for (const { key, install } of listed) {
        const at = key.lastIndexOf('@');
        const plugin = key.slice(0, at);
        const marketplace = key.slice(at + 1);
        if (at <= 0 || !TRACKED_PLUGINS.includes(plugin) || parseVersion(install.version) === undefined) {
            continue;
        }
        const user = install.scope === 'user';
        const held = chosen.get(key);
        if (held === undefined || (user && !held.user)) {
            chosen.set(key, { plugin, marketplace, version: install.version, user });
        }
    }
    return [...chosen.values()].map(({ plugin, marketplace, version }) => ({ plugin, marketplace, version }));
}
/** Where the marketplace `name` lives, from the marketplace list; undefined when it is not listed or of another shape. */
export function marketplaceSourceOf(knownText, name) {
    const known = parsed(knownText);
    const entry = isRecord(known) ? known[name] : undefined;
    if (!isRecord(entry)) {
        return undefined;
    }
    const source = entry['source'];
    const installLocation = entry['installLocation'];
    if (isRecord(source) && source['source'] === 'directory') {
        const path = source['path'];
        return typeof path === 'string' && path !== '' ? { kind: 'directory', path } : undefined;
    }
    return typeof installLocation === 'string' && installLocation !== '' ? { kind: 'clone', installLocation } : undefined;
}
/**
 * The folder of `plugin` in a marketplace, relative to its root and with no `./` or trailing slash (`plugins/teamrig`;
 * `` for the root itself); undefined when the marketplace does not list it there, or names another kind of source.
 */
export function pluginFolderOf(marketplaceText, plugin) {
    const marketplace = parsed(marketplaceText);
    const plugins = isRecord(marketplace) ? marketplace['plugins'] : undefined;
    if (!Array.isArray(plugins)) {
        return undefined;
    }
    for (const entry of plugins) {
        if (isRecord(entry) && entry['name'] === plugin) {
            const source = entry['source'];
            if (typeof source !== 'string' || !source.startsWith('./') || source.includes('..')) {
                return undefined;
            }
            return source.slice(2).replace(/\/+$/, '');
        }
    }
    return undefined;
}
/** The path of a plugin's plugin.json in its marketplace, given its folder there. */
export function pluginFilePath(folder) {
    return folder === '' ? PLUGIN_FILE : `${folder}/${PLUGIN_FILE}`;
}
/** The release version a plugin.json names; undefined when it names none of MAJOR.MINOR.PATCH form. */
export function pluginVersionOf(pluginText) {
    const plugin = parsed(pluginText);
    const version = isRecord(plugin) ? plugin['version'] : undefined;
    return typeof version === 'string' && parseVersion(version) !== undefined ? version : undefined;
}
