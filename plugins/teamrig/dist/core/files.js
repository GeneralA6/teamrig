import { appendFile, link, lstat, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorCode } from "./guards.js";
import { REPLACE_RETRY_DELAYS_MS, retryTransient } from "./retry.js";
let temporaries = 0;
/** A private sibling no other write shares: the process id parts processes, the counter parts writes in one process. */
function temporaryOf(path) {
    temporaries += 1;
    return `${path}.${process.pid}.${temporaries}.tmp`;
}
/** `temporaryOf`'s names, and `<name>.<pid>.tmp` as an older teamrig named them, before a write had its own counter. */
const TEMPORARY_NAME = /^.+\.\d+(?:\.\d+)?\.tmp$/;
/** Whether a file name is a write's temporary sibling, which only a write stopped before its rename leaves behind. */
export function isTemporaryName(name) {
    return TEMPORARY_NAME.test(name);
}
/** The path's stats when a file is there; undefined for a missing path or a folder. */
async function fileStatsOf(path) {
    try {
        const stats = await stat(path);
        return stats.isFile() ? stats : undefined;
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}
/** Whether anything is at the path, a file, a folder or a link, without following a link. */
async function pathExists(path) {
    try {
        await lstat(path);
        return true;
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT') {
            return false;
        }
        throw error;
    }
}
/** Removes a file: true when this call removed it, false when it was missing. Repeated while another process holds it open. */
function removeFile(path, sleep) {
    return retryTransient(async () => {
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
}
/** Replaces the file atomically (write a private sibling, then rename it over the file), creating folders as needed. */
export async function writeAtomic(path, data, sleep) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = temporaryOf(path);
    await writeFile(temporary, data);
    try {
        await retryTransient(() => rename(temporary, path), sleep, REPLACE_RETRY_DELAYS_MS);
    }
    catch (error) {
        await removeFile(temporary, sleep);
        throw error;
    }
}
/** Creates the file only if it does not exist yet, creating folders as needed; false when it already exists. */
export async function createOnce(path, data, sleep) {
    // Write a private sibling, then hard-link it into place: link() fails when the target exists,
    // so the file appears complete or not at all and no reader ever sees it half written.
    await mkdir(dirname(path), { recursive: true });
    const temporary = temporaryOf(path);
    await writeFile(temporary, data);
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
        await removeFile(temporary, sleep);
    }
}
/**
 * The real filesystem. Windows refuses to rename or remove a file another process holds open, so
 * those steps are repeated for about a second (`sleep` paces them) before the error is thrown.
 */
export function nodeFiles(sleep) {
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
            await writeAtomic(path, text, sleep);
        },
        async createExclusive(path, text) {
            return createOnce(path, text, sleep);
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
        async makeFolder(path) {
            await mkdir(path, { recursive: true });
        },
        async remove(path) {
            return removeFile(path, sleep);
        },
        async move(from, to) {
            if (!(await pathExists(from))) {
                return false;
            }
            if (await pathExists(to)) {
                throw new Error(`${to} exists already; a move never replaces it`);
            }
            await mkdir(dirname(to), { recursive: true });
            await retryTransient(() => rename(from, to), sleep);
            return true;
        },
        async stamp(path) {
            const stats = await fileStatsOf(path);
            return stats === undefined ? undefined : `${stats.size}:${stats.mtimeMs}`;
        },
        async modifiedAt(path) {
            return (await fileStatsOf(path))?.mtimeMs;
        },
    };
}
