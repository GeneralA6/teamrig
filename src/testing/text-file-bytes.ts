import type { FileBytes } from '../core/file-bytes.ts';
import type { Files } from '../core/files.ts';

/** `FileBytes` over any text `Files` (such as `MemoryFiles`), each file's bytes as its UTF-8 text: for tests of text files. */
export function textFileBytes(files: Files): FileBytes {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    async read(path) {
      const text = await files.read(path);
      return text === undefined ? undefined : encoder.encode(text);
    },
    async write(path, bytes) {
      await files.write(path, decoder.decode(bytes));
    },
    async createExclusive(path, bytes) {
      return files.createExclusive(path, decoder.decode(bytes));
    },
  };
}
