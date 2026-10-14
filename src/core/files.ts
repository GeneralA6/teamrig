import { appendFile, link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorCode } from './guards.ts';

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

export function nodeFiles(): Files {
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
      } catch (error) {
        if (errorCode(error) === 'EEXIST') {
          return false;
        }
        throw error;
      } finally {
        await rm(temporary, { force: true });
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
      await rm(path, { force: true });
    },
  };
}
