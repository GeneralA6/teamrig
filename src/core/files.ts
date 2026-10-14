import { appendFile, link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorCode } from './guards.ts';
import type { Sleep } from './lock.ts';
import { retryTransient } from './retry.ts';

let temporaries = 0;

/** A private sibling no other write shares: the process id parts processes, the counter parts writes in one process. */
function temporaryOf(path: string): string {
  temporaries += 1;
  return `${path}.${process.pid}.${temporaries}.tmp`;
}

/** The file operations the kit needs, behind one interface so every module can be tested in memory. */
export interface Files {
  /** The file's text, or undefined when it does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Appends text, creating the file and its folders as needed. One call is one write, so whole lines stay whole. */
  append(path: string, text: string): Promise<void>;
  /** Replaces the file atomically (write a sibling, then rename), creating folders as needed. */
  write(path: string, text: string): Promise<void>;
  /** Creates the file only if it does not exist yet; false when it already exists. */
  createExclusive(path: string, text: string): Promise<boolean>;
  /** Entry names in a folder; empty when the folder does not exist. */
  list(dir: string): Promise<string[]>;
  /** Removes a file; a missing file is not an error. */
  remove(path: string): Promise<void>;
}

/**
 * The real filesystem. Windows refuses to rename or remove a file another process holds open, so
 * those steps are repeated for about a second (`sleep` paces them) before the error is thrown.
 */
export function nodeFiles(sleep: Sleep): Files {
  const removeFile = (path: string): Promise<void> => retryTransient(() => rm(path, { force: true }), sleep);
  return {
    async read(path) {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
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
      const temporary = temporaryOf(path);
      await writeFile(temporary, text, 'utf8');
      try {
        await retryTransient(() => rename(temporary, path), sleep);
      } catch (error) {
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
      } catch (error) {
        if (errorCode(error) === 'EEXIST') {
          return false;
        }
        throw error;
      } finally {
        await removeFile(temporary);
      }
    },
    async list(dir) {
      try {
        return await readdir(dir);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          return [];
        }
        throw error;
      }
    },
    async remove(path) {
      await removeFile(path);
    },
  };
}
