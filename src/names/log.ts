import type { Files } from '../core/files.ts';
import { parseJsonl, toJsonlLine } from '../core/jsonl.ts';
import { parseRename, type Rename } from './rename.ts';

export interface RenameLogRead {
  /** In file order, oldest first. */
  readonly renames: readonly Rename[];
  /** Damaged or foreign lines: skipped, never fatal. */
  readonly unreadable: number;
  /** Lines in a newer format: skipped on read, and they block every write. */
  readonly newer: number;
}

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
    const parse = parseJsonl((await this.files.read(this.path)) ?? '');
    const renames: Rename[] = [];
    let unreadable = parse.unreadable;
    let newer = 0;
    for (const line of parse.records) {
      const result = parseRename(line);
      if (result.kind === 'rename') {
        renames.push(result.rename);
      } else if (result.kind === 'newer') {
        newer += 1;
      } else {
        unreadable += 1;
      }
    }
    return { renames, unreadable, newer };
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
