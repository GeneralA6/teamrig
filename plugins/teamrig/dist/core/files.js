import { appendFile, link, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorCode } from "./guards.js";
import { retryTransient } from "./retry.js";
let temporaries = 0;
/** A private sibling no other write shares: the process id parts processes, the counter parts writes in one process. */
function temporaryOf(path) {
    temporaries += 1;
    return `${path}.${process.pid}.${temporaries}.tmp`;
}
/**
 * The real filesystem. Windows refuses to rename or remove a file another process holds open, so
 * those steps are repeated for about a second (`sleep` paces them) before the error is thrown.
 */
export function nodeFiles(sleep) {
    const removeFile = (path) => retryTransient(async () => {
        try {
            await unlink(path);
            return true;
        }
        catch (error) {
            if (errorCode(error) === 'ENOENT') {
                return false;
            }
            throw error;
        }
    }, sleep);
    return {
        async read(path) {
            try {
                return await readFile(path, 'utf8');
            }
            catch (error) {
                if (errorCode(error) === 'ENOENT') {
                    return undefined;
                }
                throw error;
            }
        },
        async readTail(path, maxBytes) {
            let handle;
            try {
                handle = await open(path, 'r');
            }
            catch (error) {
                if (errorCode(error) === 'ENOENT') {
                    return undefined;
                }
                throw error;
            }
            try {
                const stats = await handle.stat();
                // Some systems open a folder for reading; it still has no text to read.
                if (!stats.isFile()) {
                    throw new Error(`${path} is not a file`);
                }
                const { size } = stats;
                const length = Math.min(size, maxBytes);
                const buffer = Buffer.alloc(length);
                const { bytesRead } = await handle.read(buffer, 0, length, size - length);
                return buffer.subarray(0, bytesRead).toString('utf8');
            }
            finally {
                await handle.close();
            }
        },
        async append(path, text) {
            await mkdir(dirname(path), { recursive: true });
            await appendFile(path, text, 'utf8');
        },
        async write(path, text) {
            await mkdir(dirname(path), { recursive: true });
            const temporary = temporaryOf(path);
            await writeFile(temporary, text, 'utf8');
            try {
                await retryTransient(() => rename(temporary, path), sleep);
            }
            catch (error) {
                await removeFile(temporary);
                throw error;
            }
        },
        async createExclusive(path, text) {
            // Write a private sibling, then hard-link it into place: link() fails when the target exists,
            // so the file appears complete or not at all and no reader ever sees it half written.
            await mkdir(dirname(path), { recursive: true });
            const temporary = temporaryOf(path);
            await writeFile(temporary, text, 'utf8');
            try {
                await link(temporary, path);
                return true;
            }
            catch (error) {
                if (errorCode(error) === 'EEXIST') {
                    return false;
                }
                throw error;
            }
            finally {
                await removeFile(temporary);
            }
        },
        async list(dir) {
            try {
                return await readdir(dir);
            }
            catch (error) {
                if (errorCode(error) === 'ENOENT') {
                    return [];
                }
                throw error;
            }
        },
        async remove(path) {
            return removeFile(path);
        },
        async stamp(path) {
            try {
                const stats = await stat(path);
                return stats.isFile() ? `${stats.size}:${stats.mtimeMs}` : undefined;
            }
            catch (error) {
                if (errorCode(error) === 'ENOENT') {
                    return undefined;
                }
                throw error;
            }
        },
    };
}
