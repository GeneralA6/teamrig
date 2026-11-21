import { join } from 'node:path';
import { formatConfig, writeConfigWithBackup } from "../config/load.js";
import { errorMessage, isRecord } from "../core/guards.js";
import { resolveKitHome } from "../core/home.js";
import { pathsOf } from "./host.js";
import { RefusedError } from "./runtime.js";
/**
 * The person's own user settings of the host (the file its paths port names), as the commands that change them
 * read and write them: a missing file reads as empty and one that is not a JSON object is refused before anything is
 * written; a write keeps the old file in the kit's backups folder first.
 */
/** The backup name of Claude Code's settings before a change. */
const SETTINGS_BACKUP_NAME = 'claude-settings';
/**
 * Every caller's whole work is that one file, so a host whose folders teamrig does not know refuses here, with its own
 * reason, before anything is read or written.
 */
export function settingsTargetOf(runtime) {
    return {
        settingsPath: pathsOf(runtime).userSettings(runtime.userHome),
        backupsDir: join(resolveKitHome(runtime.env, runtime.userHome), 'backups'),
    };
}
/** Claude Code's user settings; a missing file reads as empty, one that is not a JSON object is refused. */
export async function readClaudeSettings(runtime, path) {
    const text = await runtime.files.read(path);
    if (text === undefined) {
        return { json: {}, exists: false };
    }
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (error) {
        throw new RefusedError(`${path} is not valid JSON (${errorMessage(error)}); nothing written`);
    }
    if (!isRecord(raw)) {
        throw new RefusedError(`${path} is not a JSON object; nothing written`);
    }
    return { json: raw, exists: true };
}
/** Writes the settings, keeping the old file first when there was one; returns where it was kept. */
export async function writeClaudeSettings(runtime, target, settings, next) {
    if (!settings.exists) {
        await runtime.files.write(target.settingsPath, formatConfig(next));
        return undefined;
    }
    const config = { configPath: target.settingsPath, backupsDir: target.backupsDir, backupName: SETTINGS_BACKUP_NAME };
    return writeConfigWithBackup(runtime.files, config, next, runtime.clock);
}
/** A planned change's value, or the plan's problem as a refusal. */
export function checked(result) {
    if (!result.ok) {
        throw new RefusedError(result.problem);
    }
    return result.value;
}
