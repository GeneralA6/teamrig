import { isDeepStrictEqual } from 'node:util';
import { isRecord } from "../core/guards.js";
export const MANIFEST_FILE = 'package.json';
export const LOCKFILE = 'package-lock.json';
/** The root package's lifecycle scripts `npm ci` and `npm install` run. */
export const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'dependencies'];
function parseManifest(text) {
    try {
        const parsed = JSON.parse(text);
        return isRecord(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function scriptsOf(manifest) {
    const scripts = manifest['scripts'];
    return isRecord(scripts) ? scripts : {};
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** Whether a script command names `name` as a whole token: `npm run name` does, `name:sub` stays distinct. */
function mentions(command, name) {
    return typeof command === 'string' && new RegExp(`(^|[^\\w:-])${escapeRegExp(name)}($|[^\\w:-])`).test(command);
}
/** Every script an install hook runs, directly or through other scripts, in either version. */
function reachableFromHooks(before, after) {
    const names = new Set([...Object.keys(before), ...Object.keys(after)]);
    const reached = new Set(INSTALL_HOOKS.filter((hook) => names.has(hook)));
    const queue = [...reached];
    for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
        const commands = [before[current], after[current]];
        for (const name of names) {
            if (!reached.has(name) && commands.some((command) => mentions(command, name))) {
                reached.add(name);
                queue.push(name);
            }
        }
    }
    return reached;
}
/**
 * Classifies a package.json change from its text before and after (undefined: no file). A missing or unparseable
 * side counts as an install change (both missing: none), so the answer is never less safe than "a dependency change".
 */
export function classifyManifestChange(before, after) {
    if (before === undefined && after === undefined) {
        return 'none';
    }
    const old = before === undefined ? undefined : parseManifest(before);
    const next = after === undefined ? undefined : parseManifest(after);
    if (old === undefined || next === undefined) {
        return 'install';
    }
    const fields = new Set([...Object.keys(old), ...Object.keys(next)]);
    fields.delete('scripts');
    if ([...fields].some((field) => !isDeepStrictEqual(old[field], next[field]))) {
        return 'install';
    }
    const oldScripts = scriptsOf(old);
    const nextScripts = scriptsOf(next);
    const changed = [...new Set([...Object.keys(oldScripts), ...Object.keys(nextScripts)])].filter((name) => !isDeepStrictEqual(oldScripts[name], nextScripts[name]));
    if (changed.length === 0) {
        return 'none';
    }
    const reached = reachableFromHooks(oldScripts, nextScripts);
    return changed.some((name) => reached.has(name)) ? 'install' : 'scripts-only';
}
/** Whether the change needs a dependency install (`npm ci`) to keep node_modules matching the repository. */
export function needsInstall(change) {
    return change.lockfile || change.manifest === 'install';
}
/** What a range with these changed paths does to the root package files. */
export async function packageFilesChange(paths, manifestAt) {
    const manifest = paths.includes(MANIFEST_FILE) ? classifyManifestChange(await manifestAt('before'), await manifestAt('after')) : 'none';
    return { lockfile: paths.includes(LOCKFILE), manifest };
}
/** The changed root package files that need the install, as the refusal names them; empty when none does. */
export function installTouches(change) {
    return [...(change.lockfile ? [LOCKFILE] : []), ...(change.manifest === 'install' ? [`${MANIFEST_FILE} beyond scripts`] : [])];
}
