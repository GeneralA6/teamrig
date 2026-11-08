import { lstat, readdir, readlink, rmdir, symlink, unlink } from 'node:fs/promises';
import { realpathSync, type Dirent } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { errorCode } from '../core/guards.ts';

/** What is at a path as lstat sees it: a link (a symlink or a Windows junction) is never followed. */
export type EntryKind = 'link' | 'folder' | 'other';

export interface TreeEntry {
  readonly name: string;
  readonly kind: EntryKind;
}

/**
 * The file steps `teamrig worktree remove` takes. None of them deletes through a link or a folder: `unlinkLink`
 * removes one link and nothing it points to, `removeEmptyFolder` one empty folder, and the git step that follows
 * removes the worktree's own files.
 */
export interface WorktreeFiles {
  /** A folder's entries, each with its kind; empty when the folder does not exist. */
  entries(dir: string): Promise<readonly TreeEntry[]>;
  /** What is at `path`, the link itself for a link; `missing` when nothing is. */
  kindOf(path: string): Promise<EntryKind | 'missing'>;
  /** Where the link at `path` points, as an absolute path. */
  linkTarget(path: string): Promise<string>;
  /** How many entries the folder at `path` holds, through a link; undefined when no folder is there. */
  entryCount(path: string): Promise<number | undefined>;
  /** Removes the link at `path` itself; a real folder is refused by the system, never emptied. */
  unlinkLink(path: string): Promise<void>;
  /** Makes `path` a link to the folder `target`, as `unlinkLink` found it; refused when something is at `path` or its folder is gone. */
  makeLink(path: string, target: string): Promise<void>;
  /** Removes the folder at `path` when it is empty; one that holds anything is refused by the system (ENOTEMPTY), never emptied. */
  removeEmptyFolder(path: string): Promise<void>;
  /** The one spelling of an existing path (its case, separators and links resolved), to compare two spellings; undefined when nothing is there. */
  canonical(path: string): Promise<string | undefined>;
}

/** A folder's listing; undefined when the folder does not exist. */
async function listing(dir: string): Promise<Dirent[] | undefined> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function kindOfStats(stats: { isSymbolicLink(): boolean; isDirectory(): boolean }): EntryKind {
  return stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'folder' : 'other';
}

/** The real filesystem through Node, which reads a Windows junction as a link as it does a symlink. */
export const NODE_WORKTREE_FILES: WorktreeFiles = {
  async entries(dir) {
    const entries: TreeEntry[] = [];
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
    } catch (error) {
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
    } catch (error) {
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
    } catch {
      return undefined;
    }
  },
};
