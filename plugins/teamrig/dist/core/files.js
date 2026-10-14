import { appendFile, link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorCode } from "./guards.js";
export function nodeFiles() {
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
        async append(path, text) {
            await mkdir(dirname(path), { recursive: true });
            await appendFile(path, text, 'utf8');
        },
        async write(path, text) {
            await mkdir(dirname(path), { recursive: true });
            const temporary = `${path}.${process.pid}.tmp`;
            await writeFile(temporary, text, 'utf8');
            await rename(temporary, path);
        },
        async createExclusive(path, text) {
            // Write a private sibling, then hard-link it into place: link() fails when the target exists,
            // so the file appears complete or not at all and no reader ever sees it half written.
            await mkdir(dirname(path), { recursive: true });
            const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
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
                await rm(temporary, { force: true });
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
            await rm(path, { force: true });
        },
    };
}
