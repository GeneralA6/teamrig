import { parseJsonl } from '../core/jsonl.ts';
import { EVENT_VERSION, parseEvent, type RegisterEvent } from './events.ts';
import { foldEvents, type RegisterState } from './fold.ts';
import { parseMarker } from './marker.ts';
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
  /**
   * The archive segments before this text, from its rotation marker (layout.ts): 0 for a log that was
   * never rotated, which holds the whole history itself. The marker is no event and counts as no line.
   */
  readonly rotatedAfter: number;
}

/** The tasks a compaction left out of the working set: finished long ago, kept whole in the archive. */
export interface RetiredTasks {
  readonly count: number;
  /** The newest week plan among them, or null: a plan for this week or an earlier one needs the history. */
  readonly lastWeek: string | null;
}

/** The register as it stands: the replayed tasks, and what its log held that could not be read. */
export interface RegisterSnapshot {
  readonly state: RegisterState;
  readonly read: EventLogRead;
  /** null when the state holds every task; else the working set, and what it leaves to the archive. */
  readonly retired: RetiredTasks | null;
}

export function readEvents(text: string): EventLogRead {
  const parse = parseJsonl(text);
  const events: RegisterEvent[] = [];
  const seenIds: string[] = [];
  let unreadable = parse.unreadable;
  let newer = 0;
  let newestVersion = 0;
  let rotatedAfter: number | undefined;
  for (const line of parse.records) {
    const marker = parseMarker(line);
    if (marker.kind === 'marker') {
      rotatedAfter ??= marker.after;
      continue;
    }
    // A damaged marker is in a layout this code knows: it is counted, and blocks no write.
    if (marker.kind !== 'unreadable') {
      newestVersion = Math.max(newestVersion, line.version);
    }
    const result = marker.kind === 'none' ? parseEvent(line) : marker;
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
  return { events, seenIds, unreadable, newer, newestVersion, rotatedAfter: rotatedAfter ?? 0 };
}

/** True when this code may append: no line is in a format newer than the one it writes. */
export function isWritable(read: EventLogRead): boolean {
  return read.newestVersion <= EVENT_VERSION;
}

/** Replays a read log: every task as its events leave it, plus the counts `teamrig list` warns about. */
export function snapshotOf(read: EventLogRead): RegisterSnapshot {
  return { state: foldEvents(read.events, read.seenIds), read, retired: null };
}

/**
 * The register that one log text describes, read the way every teamrig command reads a register that
 * was never rotated. A rotated register (layout.ts) spreads over several files: read it with
 * `readWorkingSet` or `readHistory`.
 */
export function readRegister(text: string): RegisterSnapshot {
  return snapshotOf(readEvents(text));
}
