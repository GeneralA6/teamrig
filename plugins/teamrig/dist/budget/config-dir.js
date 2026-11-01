import { stringField } from "../core/guards.js";
import { parseObject, recordVersion, VERSION_FIELD, writableObject } from "../core/jsonl.js";
/**
 * The record's format: `v` (this number) and `configDir`. A record of another format reads as none, and one of a
 * newer format is never overwritten (`writableObject`).
 */
export const CONFIG_DIR_FORMAT = 1;
/** The record's text for `configDir`. */
export function formatConfigDirRecord(configDir) {
    return `${JSON.stringify({ [VERSION_FIELD]: CONFIG_DIR_FORMAT, configDir })}\n`;
}
/** The config dir a record of this format names; undefined for a missing, damaged or other-format record. */
function configDirIn(record) {
    return record !== undefined && recordVersion(record) === CONFIG_DIR_FORMAT ? stringField(record, 'configDir') : undefined;
}
/**
 * The Claude config dir a team's sessions last started in, as each start records it in the team's usage folder
 * (`TeamPaths.configDirRecord`), so another team of the kit home tells which login the team is on: one config dir signs
 * in one account (budget/account.ts `accountsOf`). Undefined when none is recorded, or the record cannot be read.
 */
export async function readConfigDir(files, path) {
    try {
        const text = await files.read(path);
        return configDirIn(text === undefined ? undefined : parseObject(text.trim()));
    }
    catch {
        return undefined;
    }
}
/**
 * Records `configDir` as the team's (`readConfigDir`), writing only when the record names another or none. A record of
 * a newer format is refused (`NewerDataError`), so an older teamrig never overwrites what a newer one wrote.
 */
export async function recordConfigDir(files, path, configDir) {
    if (configDirIn(writableObject(path, await files.read(path), CONFIG_DIR_FORMAT)) !== configDir) {
        await files.write(path, formatConfigDirRecord(configDir));
    }
}
