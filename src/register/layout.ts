import { isNonNegativeInteger, type JsonRecord } from '../core/guards.ts';
import { parseJsonl, type JsonlRecord } from '../core/jsonl.ts';
import { foldEvents } from './fold.ts';
import { LAYOUT_VERSION } from './marker.ts';
import { TASK_ID } from './model.ts';
import { readEvents, type EventLogRead, type RegisterSnapshot } from './snapshot.ts';

/**
 * The register's files in its state folder, and how a reader puts them together. Pure: the reader
 * hands in the texts (or a `LayoutFiles` that reads them), so a viewer reads them exactly as teamrig does.
 * - `events.jsonl`, the tail, where every write appends. A register never rotated holds its whole
 *   history there and nothing else, as before rotation existed.
 * - `archive/events-000001.jsonl` and on, the segments. A rotation turns the tail into the next segment
 *   whole and starts a new tail whose first line names it (marker.ts). A segment is never rewritten or
 *   deleted: the archive and the tail hold every line ever written, in order.
 * - `snapshot.jsonl`, the working set as of a segment: a header, then, in write order, every event but
 *   those of the tasks a compaction retired (finished long ago). A task's state depends on its own events
 *   only, so these fold to exactly the tasks it kept; retired tasks stay in the segments.
 * A working-set read folds the snapshot, the segments it does not cover and the tail, so its cost follows
 * the recent events. A history read folds every segment and the tail.
 */

export const SNAPSHOT_FILE = 'snapshot.jsonl';
export const ARCHIVE_DIR = 'archive';
/** The `type` of the snapshot's first line. */
export const SNAPSHOT_TYPE = 'snapshot';

/** Where a register's files are, from the path of its `events.jsonl`. */
export interface LayoutPaths {
  readonly tail: string;
  readonly snapshot: string;
  readonly archive: string;
  segment(n: number): string;
}

/** Segment `n`'s file name: zero-padded, so a listing sorts in write order. */
export function segmentName(n: number): string {
  return `events-${String(n).padStart(6, '0')}.jsonl`;
}

/** The register's files beside its `events.jsonl`, written with that path's folder and separator. */
export function layoutPaths(eventsPath: string): LayoutPaths {
  const cut = Math.max(eventsPath.lastIndexOf('/'), eventsPath.lastIndexOf('\\'));
  const separator = cut < 0 ? '/' : eventsPath.charAt(cut);
  const folder = eventsPath.slice(0, cut + 1);
  const archive = `${folder}${ARCHIVE_DIR}`;
  return { tail: eventsPath, snapshot: `${folder}${SNAPSHOT_FILE}`, archive, segment: (n) => `${archive}${separator}${segmentName(n)}` };
}

/** The snapshot's first line: what the working set folds from beside the events after it. */
export interface SnapshotHeader {
  /** Segments 1..covered are folded into it; the segments after it and the tail are not. */
  readonly covered: number;
  /** How many event lines follow the header, so a cut-short file is never mistaken for a whole one. */
  readonly events: number;
  /** The history's next id: retired tasks and unreadable lines reserve theirs too. */
  readonly nextId: string;
  /**
   * The history's counts, so a read of the working set warns as a read of the whole history would.
   * `orphans` counts those among the events the snapshot leaves out: its own count again as they fold.
   */
  readonly orphans: number;
  readonly unreadable: number;
  readonly newer: number;
  readonly newestVersion: number;
  /** Tasks left in the archive only, and the newest week plan among them. */
  readonly retired: number;
  readonly retiredLastWeek: string | null;
  /** When the compaction ran. */
  readonly at: string;
}

/** The header as a record, the way a compaction writes it. */
export function snapshotHeaderRecord(header: SnapshotHeader): JsonRecord {
  return { v: LAYOUT_VERSION, type: SNAPSHOT_TYPE, ...header };
}

export interface UsableSnapshot {
  readonly header: SnapshotHeader;
  readonly read: EventLogRead;
}

/** `snapshot.jsonl` as read: absent, usable, or there but unusable, which a read replaces with the whole history. */
export type SnapshotRead =
  | { readonly kind: 'none' }
  | ({ readonly kind: 'usable' } & UsableSnapshot)
  /** `newerVersion`: the layout version of a snapshot from a newer teamrig, else 0 (a damaged one). */
  | { readonly kind: 'unusable'; readonly reason: string; readonly newerVersion: number };

const WEEK = /^\d{4}-\d{2}-\d{2}$/;

const COUNT_KEYS = ['covered', 'events', 'orphans', 'unreadable', 'newer', 'newestVersion', 'retired'] as const;

type HeaderCounts = Record<(typeof COUNT_KEYS)[number], number>;

function countsOf(record: JsonRecord): HeaderCounts | string {
  const counts: HeaderCounts = { covered: 0, events: 0, orphans: 0, unreadable: 0, newer: 0, newestVersion: 0, retired: 0 };
  for (const key of COUNT_KEYS) {
    const value = record[key];
    if (!isNonNegativeInteger(value)) {
      return `${key} is not a count`;
    }
    counts[key] = value;
  }
  return counts;
}

function headerOf(line: JsonlRecord): SnapshotHeader | string {
  const { record } = line;
  const counts = countsOf(record);
  if (typeof counts === 'string') {
    return counts;
  }
  const { nextId, retiredLastWeek, at } = record;
  if (typeof nextId !== 'string' || !TASK_ID.test(nextId)) {
    return `nextId ${JSON.stringify(nextId)} is not a task id`;
  }
  if (retiredLastWeek !== null && (typeof retiredLastWeek !== 'string' || !WEEK.test(retiredLastWeek))) {
    return `retiredLastWeek ${JSON.stringify(retiredLastWeek)} is not a week`;
  }
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    return `at ${JSON.stringify(at)} is not a time`;
  }
  return { ...counts, nextId, retiredLastWeek, at };
}

function unusable(reason: string, newerVersion = 0): SnapshotRead {
  return { kind: 'unusable', reason, newerVersion };
}

/** Reads `snapshot.jsonl` (undefined: no file). Never throws: a damaged snapshot is reported and skipped. */
export function readSnapshotText(text: string | undefined): SnapshotRead {
  if (text === undefined) {
    return { kind: 'none' };
  }
  const newline = text.indexOf('\n');
  const [line] = parseJsonl(newline < 0 ? text : text.slice(0, newline)).records;
  if (line === undefined || line.record['type'] !== SNAPSHOT_TYPE) {
    return unusable('its first line is no snapshot header');
  }
  if (line.version > LAYOUT_VERSION) {
    return unusable(`a newer teamrig wrote it (layout v${line.version})`, line.version);
  }
  const header = line.version === LAYOUT_VERSION ? headerOf(line) : `layout v${line.version} is no snapshot layout`;
  if (typeof header === 'string') {
    return unusable(header);
  }
  const read = readEvents(newline < 0 ? '' : text.slice(newline + 1));
  if (read.unreadable > 0) {
    return unusable(`${read.unreadable} damaged line(s)`);
  }
  if (read.events.length + read.newer !== header.events) {
    return unusable(`it holds ${read.events.length + read.newer} event(s) where its header says ${header.events}`);
  }
  return { kind: 'usable', header, read };
}

/** What a read folds besides the tail: a snapshot to start from (none: the whole history), then segments. */
export interface ReadPlan {
  readonly base: UsableSnapshot | undefined;
  readonly segments: readonly number[];
  /** A snapshot that is there and was not used; the read counts it with the lines it skipped. */
  readonly skipped: Extract<SnapshotRead, { kind: 'unusable' }> | undefined;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
}

/** Every segment, then the tail: the whole history. */
export function historyPlan(tail: EventLogRead): ReadPlan {
  return { base: undefined, segments: range(1, tail.rotatedAfter), skipped: undefined };
}

/**
 * The snapshot, then the segments it does not cover, then the tail. Read the snapshot BEFORE the tail: a
 * rotation replaces the tail before it writes the snapshot, so a snapshot read first never covers more
 * than the tail read after it names. A snapshot that does (restored by hand, say) or that cannot be used
 * is skipped for the whole history, which is always complete.
 */
export function workingSetPlan(snapshot: SnapshotRead, tail: EventLogRead): ReadPlan {
  if (snapshot.kind === 'none') {
    return historyPlan(tail);
  }
  if (snapshot.kind === 'unusable') {
    return { ...historyPlan(tail), skipped: snapshot };
  }
  const { header, read } = snapshot;
  if (header.covered > tail.rotatedAfter) {
    const reason = `it covers segment ${header.covered}, past the segment ${tail.rotatedAfter} the log goes on from`;
    return { ...historyPlan(tail), skipped: { kind: 'unusable', reason, newerVersion: 0 } };
  }
  return { base: { header, read }, segments: range(header.covered + 1, tail.rotatedAfter), skipped: undefined };
}

/** The register a plan describes, from the segments it names (in its order) and the tail. */
export function assemble(plan: ReadPlan, segments: readonly EventLogRead[], tail: EventLogRead): RegisterSnapshot {
  if (segments.length !== plan.segments.length) {
    throw new Error(`the read plan names ${plan.segments.length} segment(s) and ${segments.length} were read`);
  }
  const header = plan.base?.header;
  const parts = [...(plan.base === undefined ? [] : [plan.base.read]), ...segments, tail];
  const skippedNewer = plan.skipped !== undefined && plan.skipped.newerVersion > 0 ? 1 : 0;
  const skippedDamaged = plan.skipped !== undefined && skippedNewer === 0 ? 1 : 0;
  const read: EventLogRead = {
    events: parts.flatMap((part) => part.events),
    seenIds: parts.flatMap((part) => part.seenIds),
    unreadable: parts.reduce((sum, part) => sum + part.unreadable, (header?.unreadable ?? 0) + skippedDamaged),
    newer: parts.reduce((sum, part) => sum + part.newer, (header?.newer ?? 0) + skippedNewer),
    newestVersion: Math.max(header?.newestVersion ?? 0, plan.skipped?.newerVersion ?? 0, ...parts.map((part) => part.newestVersion)),
    rotatedAfter: tail.rotatedAfter,
  };
  const from = header === undefined ? undefined : { tasks: new Map(), orphans: header.orphans, nextId: header.nextId };
  const retired = header === undefined || header.retired === 0 ? null : { count: header.retired, lastWeek: header.retiredLastWeek };
  return { state: foldEvents(read.events, read.seenIds, from), read, retired };
}

/** Reads one file of the layout; undefined when it does not exist. */
export interface LayoutFiles {
  read(path: string): Promise<string | undefined>;
}

/** A segment the tail or the snapshot names is gone: the history cannot be folded, so nothing is shown. */
export class MissingSegmentError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`${path} is missing: the register's archive is incomplete, so its tasks cannot be read`);
    this.name = 'MissingSegmentError';
    this.path = path;
  }
}

async function readPlanned(files: LayoutFiles, paths: LayoutPaths, plan: ReadPlan, tail: EventLogRead): Promise<RegisterSnapshot> {
  const segments: EventLogRead[] = [];
  for (const n of plan.segments) {
    const path = paths.segment(n);
    const text = await files.read(path);
    if (text === undefined) {
      throw new MissingSegmentError(path);
    }
    segments.push(readEvents(text));
  }
  return assemble(plan, segments, tail);
}

/** The working set: every active task and every task finished recently, at the cost of the recent events. */
export async function readWorkingSet(files: LayoutFiles, paths: LayoutPaths): Promise<RegisterSnapshot> {
  const snapshot = readSnapshotText(await files.read(paths.snapshot));
  const tail = readEvents((await files.read(paths.tail)) ?? '');
  return readPlanned(files, paths, workingSetPlan(snapshot, tail), tail);
}

/** Every task ever written, from every segment and the tail: the cost grows with the history. */
export async function readHistory(files: LayoutFiles, paths: LayoutPaths): Promise<RegisterSnapshot> {
  const tail = readEvents((await files.read(paths.tail)) ?? '');
  return readPlanned(files, paths, historyPlan(tail), tail);
}
