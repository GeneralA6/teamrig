import { readFile } from 'node:fs/promises';
import { createOnce, writeAtomic } from "./files.js";
import { errorCode } from "./guards.js";
/** The real file system's bytes, written the same atomic way as `nodeFiles` (`sleep` paces a retried rename). */
export function nodeFileBytes(sleep) {
    return {
        async read(path) {
            try {
                return await readFile(path);
            }
            catch (error) {
                if (errorCode(error) === 'ENOENT') {
                    return undefined;
                }
                throw error;
            }
        },
        async write(path, bytes) {
            await writeAtomic(path, bytes, sleep);
        },
        async createExclusive(path, bytes) {
            return createOnce(path, bytes, sleep);
        },
    };
}
