import type { Files } from '../core/files.ts';
import { parseJsonl, toJsonlLine } from '../core/jsonl.ts';
import { EVENT_VERSION, parseEvent, type RegisterEvent } from './events.ts';
import { TASK_ID } from './model.ts';

export interface EventLogRead {
  readonly events: readonly RegisterEvent[];
  /** Task ids on lines that did not parse into events; they still reserve their ids. */
  readonly seenIds: readonly string[];
  /** Damaged lines and events this code should understand but cannot: counted, never fatal. */
  readonly unreadable: number;
  /** Lines in a newer format: skipped on read, and they block every write. */
  readonly newer: number;
  readonly newestVersion: number;
}

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

export function readEvents(text: string): EventLogRead {
  const parse = parseJsonl(text);
  const events: RegisterEvent[] = [];
  const seenIds: string[] = [];
  let unreadable = parse.unreadable;
  let newer = 0;
  for (const line of parse.records) {
    const result = parseEvent(line);
    if (result.kind === 'event') {
      events.push(result.event);
      continue;
    }
    if (result.kind === 'newer') {
      newer += 1;
    } else {
      unreadable += 1;
    }
    const id = line.record['id'];
    if (typeof id === 'string' && TASK_ID.test(id)) {
      seenIds.push(id);
    }
  }
  const newestVersion = parse.records.reduce((max, line) => Math.max(max, line.version), 0);
  return { events, seenIds, unreadable, newer, newestVersion };
}

/** True when this code may append: no line is in a format newer than the one it writes. */
export function isWritable(read: EventLogRead): boolean {
  return read.newestVersion <= EVENT_VERSION;
}
