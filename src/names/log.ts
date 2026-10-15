import type { Files } from '../core/files.ts';
import { toJsonlLine } from '../core/jsonl.ts';
import { readRenames, type Rename, type RenameLogRead } from './rename.ts';

/** The team's append-only rename log. */
export interface RenameLog {
  readonly path: string;
  read(): Promise<RenameLogRead>;
  append(rename: Rename): Promise<void>;
}

export class JsonlRenameLog implements RenameLog {
  readonly path: string;
  private readonly files: Files;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  async read(): Promise<RenameLogRead> {
    return readRenames((await this.files.read(this.path)) ?? '');
  }

  /**
   * One whole line in one append, so a crash never leaves half a record. A last line written by
   * hand without its newline gets one first, so the two records never run together.
   */
  async append(rename: Rename): Promise<void> {
    const current = await this.files.read(this.path);
    const separator = current === undefined || current === '' || current.endsWith('\n') ? '' : '\n';
    await this.files.append(this.path, `${separator}${toJsonlLine({ ...rename })}`);
  }
}
