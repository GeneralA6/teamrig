import { parseJsonl } from '../core/jsonl.ts';
import { EVENT_VERSION, parseEvent, type RegisterEvent } from './events.ts';
import { foldEvents, type RegisterState } from './fold.ts';
import { TASK_ID } from './model.ts';

/**
 * Reading the register from its log's text, with no file system: the half of the store a viewer
 * needs too. Pure, so another tool can show a register exactly as teamrig reads it.
 */
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

/** The register as it stands: the replayed tasks, and what its log held that could not be read. */
export interface RegisterSnapshot {
  readonly state: RegisterState;
  readonly read: EventLogRead;
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

/** Replays a read log: every task as its events leave it, plus the counts `teamrig list` warns about. */
export function snapshotOf(read: EventLogRead): RegisterSnapshot {
  return { state: foldEvents(read.events, read.seenIds), read };
}

/** The register that an `events.jsonl` text describes, read the way every teamrig command reads it. */
export function readRegister(text: string): RegisterSnapshot {
  return snapshotOf(readEvents(text));
}
