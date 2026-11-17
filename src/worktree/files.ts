import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, readlink, rmdir, symlink, unlink } from 'node:fs/promises';
import { realpathSync, type Dirent } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { errorCode, errorMessage } from '../core/guards.ts';

/** What is at a path as lstat sees it: a link (a symlink or a Windows junction) is never followed. */
export type EntryKind = 'link' | 'folder' | 'other';

export interface TreeEntry {
  readonly name: string;
  readonly kind: EntryKind;
}

/** A running program and the folder it runs in. */
export interface Program {
  readonly pid: number;
  readonly name: string;
  /** Its working folder, as the system spells it. */
  readonly folder: string;
}

/** The working folder of every other program the system lets this user read, or why it cannot tell (#797). */
export type ProgramsRead = { readonly kind: 'read'; readonly programs: readonly Program[] } | { readonly kind: 'unknown'; readonly reason: string };

/** How long `lsof` may take to list every program's working folder. */
const LSOF_TIMEOUT_MS = 10_000;

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
  /** The working folder of every other running program, so a worktree one runs in is not removed partway (#797). */
  workingFolders(): Promise<ProgramsRead>;
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
  async workingFolders() {
    if (process.platform === 'linux') {
      return await procWorkingFolders();
    }
    if (process.platform === 'darwin') {
      return await lsofWorkingFolders();
    }
    return { kind: 'unknown', reason: `${process.platform === 'win32' ? 'Windows' : process.platform} gives no plain way to read another program's working folder` };
  },
};

/** Linux: each `/proc/<pid>/cwd` link this user may read; a program that ended, or another user's, is skipped. */
async function procWorkingFolders(): Promise<ProgramsRead> {
  let pids: string[];
  try {
    pids = (await readdir('/proc')).filter((name) => /^\d+$/u.test(name));
  } catch (error) {
    return { kind: 'unknown', reason: `/proc cannot be read (${errorMessage(error)})` };
  }
  const programs: Program[] = [];
  for (const id of pids) {
    const pid = Number(id);
    if (pid === process.pid) {
      continue;
    }
    try {
      const folder = await readlink(`/proc/${id}/cwd`);
      programs.push({ pid, name: (await readFile(`/proc/${id}/comm`, 'utf8')).trim(), folder });
    } catch {
      // Ended since the listing, or another user's: neither is read.
    }
  }
  return { kind: 'read', programs };
}

/** macOS: `lsof -d cwd`, whose exit is 1 when it could not read some program, though it lists the rest. */
async function lsofWorkingFolders(): Promise<ProgramsRead> {
  return await new Promise((settle) => {
    execFile('lsof', ['-n', '-P', '-d', 'cwd', '-F', 'pcn'], { timeout: LSOF_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      const programs = parseLsofFolders(stdout, process.pid);
      settle(error !== null && programs.length === 0 ? { kind: 'unknown', reason: `lsof did not list them (${errorMessage(error)})` } : { kind: 'read', programs });
    });
  });
}

/** `lsof -F pcn` output: a `p<pid>` line opens each program, then its `c<name>`, and `n<folder>` for its cwd; `self` is left out. */
export function parseLsofFolders(text: string, self: number): Program[] {
  const programs: Program[] = [];
  let pid: number | undefined;
  let name = '';
  for (const line of text.split('\n')) {
    const field = line.slice(1);
    if (line.startsWith('p')) {
      pid = Number(field);
      name = '';
    } else if (line.startsWith('c')) {
      name = field;
    } else if (line.startsWith('n') && pid !== undefined && Number.isInteger(pid) && pid !== self) {
      programs.push({ pid, name, folder: field });
    }
  }
  return programs;
}
