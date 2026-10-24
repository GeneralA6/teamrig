import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { errorCode } from "./guards.js";
/** A path that is not there, or whose parent is a file. */
function isMissing(error) {
    const code = errorCode(error);
    return code === 'ENOENT' || code === 'ENOTDIR';
}
/** The real filesystem's plugin store, as the idle pass dates it before it reopens a session (`cli/settled-install.ts`). */
export const NODE_STORE_FOLDERS = {
    async changedAt(path) {
        try {
            return (await stat(path)).mtimeMs;
        }
        catch (error) {
            if (isMissing(error)) {
                return undefined;
            }
            throw error;
        }
    },
    async foldersIn(path) {
        try {
            const entries = await readdir(path, { withFileTypes: true });
            return entries.filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
        }
        catch (error) {
            if (isMissing(error)) {
                return [];
            }
            throw error;
        }
    },
};
