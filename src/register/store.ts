import type { Files } from '../core/files.ts';
import { toJsonlLine } from '../core/jsonl.ts';
import type { RegisterEvent } from './events.ts';
import { readEvents, type EventLogRead } from './snapshot.ts';

/** The register's append-only event log. */
export interface EventLog {
  readonly path: string;
  read(): Promise<EventLogRead>;
  /** Appends one whole line; readers never need the lock. */
  append(event: RegisterEvent): Promise<void>;
}

export class JsonlEventLog implements EventLog {
  readonly path: string;
  private readonly files: Files;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  async read(): Promise<EventLogRead> {
    return readEvents((await this.files.read(this.path)) ?? '');
  }

  async append(event: RegisterEvent): Promise<void> {
    await this.files.append(this.path, toJsonlLine({ ...event }));
  }
}
