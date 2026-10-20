/**
 * Claude Code's plugin list, `installed_plugins.json` (version 2), and the plugin cache that holds each install, per
 * scope. The tab's reload hand reads the list to see an update (`mod/reload-hand.ts`); a session teamrig starts leaves
 * the cache's `bin` folders off the PATH it hands on (`open/session-env.ts`). The mod runs inside Claude Code without
 * Node, so this file imports nothing from Node.
 */
import { isRecord } from "./guards.js";
/** The plugin list's name, in Claude Code's `plugins` folder. */
export const INSTALLED_PLUGINS_FILE = 'installed_plugins.json';
function isOptionalText(value) {
    return value === undefined || typeof value === 'string';
}
function parsed(text) {
    try {
        const value = JSON.parse(text);
        return value;
    }
    catch {
        return undefined;
    }
}
function installOf(entry) {
    if (!isRecord(entry)) {
        return undefined;
    }
    const scope = entry['scope'];
    const installPath = entry['installPath'];
    const version = entry['version'];
    const gitCommitSha = entry['gitCommitSha'];
    const projectPath = entry['projectPath'];
    if (typeof scope !== 'string' || typeof installPath !== 'string') {
        return undefined;
    }
    if (!isOptionalText(version) || !isOptionalText(gitCommitSha) || !isOptionalText(projectPath)) {
        return undefined;
    }
    return { scope, installPath, version: version ?? '', gitCommitSha: gitCommitSha ?? '', projectPath };
}
/**
 * Every install the plugin list holds, in its order. Undefined for a text that is not the list's shape, an install
 * of another shape included, so a file mid-write or of another version reads as none.
 */
export function installsOf(text) {
    const file = parsed(text);
    if (!isRecord(file)) {
        return undefined;
    }
    const plugins = file['plugins'];
    if (!isRecord(plugins)) {
        return undefined;
    }
    const listed = [];
    for (const [key, entries] of Object.entries(plugins)) {
        if (!Array.isArray(entries)) {
            return undefined;
        }
        for (const entry of entries) {
            const install = installOf(entry);
            if (install === undefined) {
                return undefined;
            }
            listed.push({ key, install });
        }
    }
    return listed;
}
/** A path with a drive letter or a UNC start: Windows, where case and the slash's direction do not matter. */
const WINDOWS_PATH = /^(?:[A-Za-z]:|[\\/]{2})/;
function withoutTrailingSlash(path) {
    let end = path.length;
    while (end > 1 && path[end - 1] === '/') {
        end -= 1;
    }
    return path.slice(0, end);
}
/** Whether two spellings name one folder; on Windows `\` and `/` are one separator and case does not matter. */
export function samePath(a, b) {
    if (WINDOWS_PATH.test(a) || WINDOWS_PATH.test(b)) {
        const windows = (path) => withoutTrailingSlash(path.replaceAll('\\', '/')).toLowerCase();
        return windows(a) === windows(b);
    }
    return withoutTrailingSlash(a) === withoutTrailingSlash(b);
}
/** Whether an install applies to a tab whose project root is `projectRoot`: a user-scope one always, a project- or local-scope one for that project only. */
export function appliesTo(install, projectRoot) {
    if (install.scope === 'user') {
        return true;
    }
    const forAProject = install.scope === 'project' || install.scope === 'local';
    return forAProject && install.projectPath !== undefined && samePath(install.projectPath, projectRoot);
}
/**
 * Claude Code's `plugins` folder, which holds installed_plugins.json, for a plugin it runs from its cache
 * (`<config>/plugins/cache/<marketplace>/<plugin>/<version>`), so the path follows the configuration folder this
 * Claude Code really uses (`CLAUDE_CONFIG_DIR` too) with no environment read. Undefined for a plugin run from anywhere
 * else (`--plugin-dir`, a marketplace that is a local folder).
 */
export function pluginsFolderOf(pluginRoot) {
    const parts = pluginRoot.split(/[\\/]/);
    while (parts.length > 0 && parts[parts.length - 1] === '') {
        parts.pop();
    }
    const count = parts.length;
    if (count < 6 || parts[count - 5] !== 'plugins' || parts[count - 4] !== 'cache') {
        return undefined;
    }
    return parts.slice(0, count - 4).join('/');
}
/**
 * Whether a folder is the `bin` folder of a plugin install in Claude Code's cache
 * (`<config>/plugins/cache/<marketplace>/<plugin>/<version>/bin`), the folder Claude Code adds to its Bash tool's PATH
 * while the plugin is enabled.
 */
export function isPluginCacheBin(folder) {
    const parts = folder.split(/[\\/]/);
    while (parts.length > 0 && parts[parts.length - 1] === '') {
        parts.pop();
    }
    return parts.at(-1) === 'bin' && pluginsFolderOf(parts.slice(0, -1).join('/')) !== undefined;
}
