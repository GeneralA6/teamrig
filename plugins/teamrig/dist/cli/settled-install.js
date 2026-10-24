import { join, posix } from 'node:path';
import { isRecord, isStringArray } from "../core/guards.js";
import { claudeConfigDir, KIT_NAME } from "../core/home.js";
import { appliesTo, INSTALLED_PLUGINS_FILE, installsOf } from "../core/installed-plugins.js";
import { newestNear, storeTimesOf } from "../core/plugin-store.js";
/**
 * How long the plugin store must stand still before the idle pass reopens a session (T1100): a tab that loads plugins
 * while an install is copied loads part of one and runs without teamrig's hooks (T561, T1002), and no one watches a
 * tab the pass reopened.
 */
export const REOPEN_SETTLE_MS = 30_000;
/** The file teamrig's hooks run, in its install folder. */
const KIT_CLI = 'dist/cli/main.js';
/** teamrig's hooks file, which names its mod modules, in its install folder. */
const KIT_HOOKS = 'hooks/hooks.json';
const SETTLED = { kind: 'settled' };
function parsedJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
/** The mod modules a hooks file names, as paths in the install folder; undefined when it does not read as one. */
function modulesOf(text) {
    const file = parsedJson(text);
    if (!isRecord(file)) {
        return undefined;
    }
    const modules = file['modules'] ?? [];
    return isStringArray(modules) ? modules.map((module) => posix.join('hooks', module)) : undefined;
}
/** What a teamrig install lacks of the files its hooks need, in the order a tab loads them; undefined when none. */
async function lackOf(files, install) {
    const hooks = await files.read(join(install.installPath, KIT_HOOKS));
    if (hooks === undefined) {
        return KIT_HOOKS;
    }
    const modules = modulesOf(hooks);
    if (modules === undefined) {
        return `a ${KIT_HOOKS} that reads as a hooks file`;
    }
    for (const path of [...modules, KIT_CLI]) {
        if ((await files.modifiedAt(join(install.installPath, path))) === undefined) {
            return path;
        }
    }
    return undefined;
}
/**
 * Whether a session reopened now for `project` would load whole plugins: each teamrig install that applies to it has
 * its hooks file, the mod modules that file names and the CLI they run, and no part of the store an install writes
 * changed within REOPEN_SETTLE_MS (`storeTimesOf`: a copy names the new version before it ends). With no plugin list
 * there is no store to wait for (a plugin run from a folder); a list that does not read as Claude Code's is a store
 * mid-write.
 */
export async function installStateOf(runtime, project) {
    const pluginsFolder = join(claudeConfigDir(runtime.env, runtime.userHome), 'plugins');
    const text = await runtime.files.read(join(pluginsFolder, INSTALLED_PLUGINS_FILE));
    if (text === undefined) {
        return SETTLED;
    }
    const installs = installsOf(text)?.filter(({ install }) => appliesTo(install, project));
    if (installs === undefined) {
        return { kind: 'unsettled', why: `${INSTALLED_PLUGINS_FILE} does not read as Claude Code's plugin list` };
    }
    for (const { key, install } of installs) {
        if (key.startsWith(`${KIT_NAME}@`)) {
            const lack = await lackOf(runtime.files, install);
            if (lack !== undefined) {
                return { kind: 'unsettled', why: `${KIT_NAME} ${install.version} lacks ${lack}` };
            }
        }
    }
    const now = runtime.clock.now();
    const changedAt = newestNear(await storeTimesOf(runtime.pluginStore, pluginsFolder, installs), now, REOPEN_SETTLE_MS);
    if (changedAt === undefined) {
        return SETTLED;
    }
    const seconds = Math.max(0, Math.floor((now - changedAt) / 1000));
    return { kind: 'unsettled', why: `the plugin store changed ${seconds} s ago, under ${REOPEN_SETTLE_MS / 1000} s: an install may still be copying` };
}
/** Why a reopen waits, as the pass and its act say it, for an install unsettled for `why`. */
export function settleWaitText(why) {
    return `${why}, so the reopen waits for a settled install`;
}
