import { jsonObjectOf } from "./settings-env.js";
async function readOne(permissions, files, path) {
    const text = await files.read(path);
    if (text === undefined) {
        return undefined;
    }
    const settings = jsonObjectOf(text);
    if (settings === undefined) {
        return { kind: 'unreadable', path };
    }
    return { kind: 'deny', path, deny: permissions.read(settings).deny };
}
/** The deny lines of each settings file that exists, in the order given. A missing file is left out; it only reads. */
export async function readSettingsDeny(permissions, files, paths) {
    const read = await Promise.all(paths.map((path) => readOne(permissions, files, path)));
    return read.filter((settings) => settings !== undefined);
}
/**
 * The secret deny `lines` (the host's lines for the platform) no readable file holds, word for word (spaces at either
 * end aside), in their order. A deny line in any settings file a session reads applies to it, so the files count as
 * one list.
 */
export function missingDenyLines(read, lines) {
    const held = new Set(read.flatMap((settings) => (settings.kind === 'deny' ? settings.deny.map((rule) => rule.trim()) : [])));
    return lines.filter((line) => !held.has(line));
}
