import type { Files } from '../core/files.ts';
import { toJsonlLine } from '../core/jsonl.ts';
import type { RegisterEvent } from './events.ts';
import { layoutPaths, readHistory, readWorkingSet, type LayoutPaths } from './layout.ts';
import type { RegisterSnapshot } from './snapshot.ts';

/** The register's event log: an append-only tail, and once rotated, its archive and snapshot (layout.ts). */
export interface EventLog {
  /** The tail, `events.jsonl`, which every write appends to. */
  readonly path: string;
  /** The working set: every active task and every task finished recently, at the cost of the recent events. */
  read(): Promise<RegisterSnapshot>;
  /** Every task ever written, from the whole archive: the cost grows with the history. */
  readHistory(): Promise<RegisterSnapshot>;
  /** Appends one whole line; readers never need the lock. */
  append(event: RegisterEvent): Promise<void>;
}

export class JsonlEventLog implements EventLog {
  readonly path: string;
  private readonly files: Files;
  private readonly layout: LayoutPaths;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
    this.layout = layoutPaths(path);
  }

  read(): Promise<RegisterSnapshot> {
    return readWorkingSet(this.files, this.layout);
  }

  readHistory(): Promise<RegisterSnapshot> {
    return readHistory(this.files, this.layout);
  }

  async append(event: RegisterEvent): Promise<void> {
    await this.files.append(this.path, toJsonlLine({ ...event }));
  }
}
