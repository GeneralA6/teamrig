import { isRecord, recordField } from "../core/guards.js";
/**
 * The settings files a session started in `project` reads, in the order the host reads them: the person's own, then
 * the project folder's. A project folder whose file is the person's own lists that file once.
 */
export function sessionSettingsFiles({ paths, userHome }, project) {
    return [...new Set([paths.userSettings(userHome), ...paths.folderSettings(project).map((file) => file.path)])];
}
/** The text as a JSON object, or undefined when it is not one; a leading byte order mark is skipped. */
export function jsonObjectOf(text) {
    let parsed;
    try {
        parsed = JSON.parse(text.replace(/^﻿/, ''));
    }
    catch {
        return undefined;
    }
    return isRecord(parsed) ? parsed : undefined;
}
/** A variable's value as text: a string as it is, a number or a true/false as written; anything else is no value. */
function envValue(value) {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}
async function readOne(files, path) {
    const text = await files.read(path);
    if (text === undefined) {
        return undefined;
    }
    const settings = jsonObjectOf(text);
    if (settings === undefined) {
        return { kind: 'unreadable', path };
    }
    const block = Object.entries(recordField(settings, 'env') ?? {}).flatMap(([name, value]) => {
        const written = envValue(value);
        return written === undefined ? [] : [[name, written]];
    });
    return { kind: 'env', path, env: Object.fromEntries(block) };
}
/** The `env` block of each settings file that exists, in the order given. A missing file is left out; it only reads. */
export async function readSettingsEnv(files, paths) {
    const read = await Promise.all(paths.map((path) => readOne(files, path)));
    return read.filter((settings) => settings !== undefined);
}
