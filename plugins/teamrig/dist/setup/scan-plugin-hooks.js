import { join } from 'node:path';
import { isRecord } from "../core/guards.js";
import { appliesTo, INSTALLED_PLUGINS_FILE, installsOf, samePath } from "../core/installed-plugins.js";
import { jsonObjectOf } from "../doctor/settings-env.js";
import { hookFindings } from "./scan-settings.js";
async function jsonAt(files, path) {
    const text = await files.read(path);
    return text === undefined ? undefined : jsonObjectOf(text);
}
/** The settings files whose `enabledPlugins` turn a plugin on or off for the project, the one that wins last. */
function enablingFiles(at) {
    const project = join(at.project, '.claude');
    return [join(at.claudeDir, 'settings.json'), join(project, 'settings.json'), join(project, 'settings.local.json')];
}
/** Each plugin the settings files turn on (true) or off (false), as the last file to name it says. */
async function enabledPlugins(files, at) {
    const enabled = new Map();
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
function namedFiles(hooks) {
    if (typeof hooks === 'string') {
        return [hooks];
    }
    return Array.isArray(hooks) ? hooks.filter((path) => typeof path === 'string') : [];
}
/**
 * An install's hooks: its `hooks/hooks.json`, each file its manifest's `hooks` names (relative to the install), each
 * read once, and the manifest itself when its `hooks` holds them inline. A file that is missing or not JSON adds none.
 */
async function hooksSources(files, installPath) {
    const manifestPath = join(installPath, '.claude-plugin', 'plugin.json');
    const manifest = await jsonAt(files, manifestPath);
    const named = namedFiles(manifest?.['hooks']).map((path) => join(installPath, path));
    const paths = [join(installPath, 'hooks', 'hooks.json'), ...named].filter((path, index, all) => all.findIndex((other) => samePath(other, path)) === index);
    const read = await Promise.all(paths.map(async (path) => ({ path, settings: await jsonAt(files, path) })));
    const sources = read.flatMap(({ path, settings }) => (settings === undefined ? [] : [{ path, settings }]));
    return manifest !== undefined && isRecord(manifest['hooks']) ? [...sources, { path: manifestPath, settings: manifest }] : sources;
}
/**
 * The context hooks of the plugins installed for `at.project` that the transcripts read (`hooks`) show printing into
 * the context, each named with its plugin and the hooks file that holds it. A plugin a settings file turns off is
 * skipped; one no file names counts as on, since only a hook that ran is a finding. One command a plugin lists under
 * several matchers, or two installs of one plugin list, is one finding. No plugin list, or one of another shape, finds
 * nothing. It only reads.
 */
export async function scanPluginHooks(files, at, hooks, secrets) {
    const text = await files.read(join(at.claudeDir, 'plugins', INSTALLED_PLUGINS_FILE));
    const installs = (text === undefined ? undefined : installsOf(text)) ?? [];
    const enabled = await enabledPlugins(files, at);
    const found = new Map();
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
