import { lstat, readdir, readlink, rmdir, symlink, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { errorCode } from "../core/guards.js";
/** A folder's listing; undefined when the folder does not exist. */
async function listing(dir) {
    try {
        return await readdir(dir, { withFileTypes: true });
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}
function kindOfStats(stats) {
    return stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'folder' : 'other';
}
/** The real filesystem through Node, which reads a Windows junction as a link as it does a symlink. */
export const NODE_WORKTREE_FILES = {
    async entries(dir) {
        const entries = [];
        for (const dirent of (await listing(dir)) ?? []) {
            // Windows marks every reparse point a link in a folder listing, a cloud placeholder too; lstat tells a
            // real link (a symlink or a junction) from a folder that only carries one.
            const kind = dirent.isSymbolicLink() ? kindOfStats(await lstat(resolve(dir, dirent.name))) : kindOfStats(dirent);
            entries.push({ name: dirent.name, kind });
        }
        return entries;
    },
    async kindOf(path) {
        try {
            return kindOfStats(await lstat(path));
        }
        catch (error) {
            if (errorCode(error) === 'ENOENT') {
                return 'missing';
            }
            throw error;
        }
    },
    async linkTarget(path) {
        return resolve(dirname(path), await readlink(path));
    },
    async entryCount(path) {
        try {
            return (await readdir(path)).length;
        }
        catch (error) {
            const code = errorCode(error);
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                return undefined;
            }
            throw error;
        }
    },
    async unlinkLink(path) {
        // unlink, never rm or rmdir: it removes a symlink or a junction itself and fails on a real folder.
        await unlink(path);
    },
    async makeLink(path, target) {
        // A junction on Windows, which needs no privilege; elsewhere Node ignores the type and makes a symlink.
        await symlink(target, path, 'junction');
    },
    async removeEmptyFolder(path) {
        // rmdir with no recursive option: it fails on a folder that holds anything, so nothing in it can be lost.
        await rmdir(path);
    },
    async canonical(path) {
        try {
            return realpathSync.native(path);
        }
        catch {
            return undefined;
        }
    },
};
