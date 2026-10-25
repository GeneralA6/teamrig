import { readFile } from 'node:fs/promises';
import { createOnce, writeAtomic } from './files.ts';
import { errorCode } from './guards.ts';
import type { Sleep } from './lock.ts';

/**
 * Byte for byte file operations, for copies that must match the original exactly (a skill's image as
 * well as its text). `Files` stays the text port every other module and its fakes use.
 */
export interface FileBytes {
  /** The file's bytes, or undefined when it does not exist. */
  read(path: string): Promise<Uint8Array | undefined>;
  /** Replaces the file atomically, creating folders as needed. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Creates the file only if it does not exist yet, creating folders as needed; false when it already exists. */
  createExclusive(path: string, bytes: Uint8Array): Promise<boolean>;
}

/** The real file system's bytes, written the same atomic way as `nodeFiles` (`sleep` paces a retried rename). */
export function nodeFileBytes(sleep: Sleep): FileBytes {
  return {
    async read(path) {
      try {
        return await readFile(path);
      } catch (error) {
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
