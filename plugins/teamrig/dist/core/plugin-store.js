/**
 * Claude Code's plugin store as an install writes it: the plugin list, the marketplace list and each install's folders
 * in the cache. A tab that loads plugins while an install is copied loads part of one, so the tab's reload hand
 * (`mod/reload-hand.ts`) waits for the store to stand still before it runs /reload-plugins. The mod runs inside Claude
 * Code without Node, so this file imports nothing from Node.
 */
import { INSTALLED_PLUGINS_FILE } from "./installed-plugins.js";
/** The marketplace list, beside installed_plugins.json, which a marketplace update rewrites as it ends. */
export const KNOWN_MARKETPLACES_FILE = 'known_marketplaces.json';
/** The most folders of the installs one look at the store reads, so a large install keeps the look bounded. */
export const STORE_FOLDERS_MAX = 500;
/** The folder that holds a path: what comes before its last `/` or `\`. */
export function parentOf(path) {
    const trimmed = path.replace(/[\\/]+$/, '');
    const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return cut <= 0 ? trimmed : trimmed.slice(0, cut);
}
/**
 * The newest of `times` less than `windowMs` from `now` either way: a time a little ahead of the clock is a change
 * now, while one far ahead (the clock set back since) never holds a wait for good. Undefined when none is.
 */
export function newestNear(times, now, windowMs) {
    const near = times.filter((time) => Math.abs(now - time) < windowMs);
    return near.length === 0 ? undefined : Math.max(...near);
}
/**
 * When each part of the store an install writes last changed, in milliseconds since the epoch: the plugin list in
 * `pluginsFolder`, the marketplace list, and for each of `installs` its plugin's folder (a version added or removed)
 * and every folder of the install, breadth first, up to STORE_FOLDERS_MAX; a missing one is left out (its plugin's
 * folder dates a removal). `claude plugin update` creates the new version's folder, copies the plugin into it and
 * names it in the plugin list before the copy ends, and a copied file keeps its source's time, so only the folders
 * date the copy. A reload while it runs loads part of the plugin: on 10-19 one ran 0.4 s into teamrig's copy and left
 * a tab without teamrig's hooks for 15 hours (T561).
 */
export async function storeTimesOf(store, pluginsFolder, installs) {
    const files = [`${pluginsFolder}/${INSTALLED_PLUGINS_FILE}`, `${pluginsFolder}/${KNOWN_MARKETPLACES_FILE}`];
    const folders = installs.map(({ install }) => parentOf(install.installPath));
    let level = installs.map(({ install }) => install.installPath);
    let budget = STORE_FOLDERS_MAX;
    while (level.length > 0 && budget > 0) {
        const taken = level.slice(0, budget);
        budget -= taken.length;
        folders.push(...taken);
        level = budget > 0 ? (await Promise.all(taken.map((folder) => store.foldersIn(folder)))).flat() : [];
    }
    const paths = [...new Set([...files, ...folders])];
    const times = await Promise.all(paths.map((path) => store.changedAt(path)));
    return times.filter((time) => time !== undefined);
}
