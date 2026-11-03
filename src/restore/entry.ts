import { isNonNegativeInteger, stringField, type JsonRecord } from '../core/guards.ts';
import { ID_PATTERN } from '../core/ids.ts';
import { parseObject } from '../core/jsonl.ts';
import { MS_PER_MINUTE } from '../core/time.ts';
import { CLAUDE_SESSION_ID } from '../inbox/marks.ts';

/**
 * A Claude Code session as the restore after a reboot sees it: where it runs and what it was doing at its
 * last hook event. `hook restore-track` writes one on each start, prompt, turn end, API error and end, and
 * `hook tool-end` at a tool's end every few minutes, so a session the shutdown killed is one whose last event left
 * it open, or ended it with no reason of its own.
 */

/** What the session was doing at its last event: waiting for a prompt, in a turn, or stopped by an API error. */
export type ActivityState = 'ready' | 'working' | 'error';

const ACTIVITY_STATES: readonly ActivityState[] = ['ready', 'working', 'error'];

/** The ends a person or Claude Code chose; any other end (`other`) may be the shutdown closing the terminal. */
export const INTENTIONAL_END_REASONS: ReadonlySet<string> = new Set(['clear', 'resume', 'logout', 'prompt_input_exit']);

/** The reason an end without one of Claude Code's own is recorded under. */
export const OTHER_END = 'other';

export interface RestoreEntry {
  readonly claudeSession: string;
  /** The folder it started in, kept from its first event: a later `cd` does not move it. */
  readonly projectDir: string;
  readonly transcriptPath: string | undefined;
  /** How it was started (`$CLAUDE_CODE_ENTRYPOINT`): only `cli` is a tab to reopen. */
  readonly entrypoint: string | undefined;
  /** `$CLAUDE_CODE_SESSION_KIND`: `bg` is a background session, never reopened. */
  readonly sessionKind: string | undefined;
  /** Its Claude Code's process id at its last event. */
  readonly pid: number | undefined;
  /** `$TEAMRIG_TEAM` and `$TEAMRIG_SESSION` at its last event: a session `teamrig launch` started. */
  readonly team: string | undefined;
  readonly session: string | undefined;
  readonly state: ActivityState;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Restores tried since its last start; past the limit it is given up. */
  readonly restoreAttempts: number;
  /** When a restore last reopened it; its next start clears it. */
  readonly restoredAt: number | undefined;
  /** When an end came, and its reason. */
  readonly endedAt: number | undefined;
  readonly endReason: string | undefined;
}

/**
 * The least time between two writes a tool's end makes: often enough that a session's entry stays within minutes
 * of its transcript through a long turn (the fleet check reads a larger gap as a tab running without its hooks),
 * rare enough that most tool ends only read the entry.
 */
export const TOOL_END_WRITE_MS = 5 * MS_PER_MINUTE;

/**
 * A hook event, as the tracker reads it. A tool's end (`tool`) in the main thread says the session is in a turn; a
 * helper's says only that its hooks run. A turn that failed (`error`) carries the API error it ended on
 * (src/restore/turn-error.ts); undefined when neither the payload nor the transcript names one.
 */
export type TrackEvent =
  | { readonly kind: 'start' }
  | { readonly kind: 'working' }
  | { readonly kind: 'tool'; readonly mainThread: boolean }
  | { readonly kind: 'ready' }
  | { readonly kind: 'error'; readonly code: string | undefined }
  | { readonly kind: 'end'; readonly reason: string | undefined };

/** What an event tells about its session; undefined where it does not say. */
export interface TrackFacts {
  readonly claudeSession: string;
  readonly at: number;
  readonly projectDir: string | undefined;
  readonly transcriptPath: string | undefined;
  readonly entrypoint: string | undefined;
  readonly sessionKind: string | undefined;
  readonly pid: number | undefined;
  readonly team: string | undefined;
  readonly session: string | undefined;
}

export type TrackChange = { readonly kind: 'write'; readonly entry: RestoreEntry } | { readonly kind: 'remove' } | { readonly kind: 'none' };

/**
 * How an event changes a session's entry. An end the person or Claude Code chose removes it: nothing is
 * left to restore. A start begins it afresh (ready, no restore pending). A first event that names no folder
 * writes nothing, since a tab cannot be reopened nowhere. A tool's end in the main thread marks it working (a
 * helper's runs on past its turn's end, and keeps the state), and either writes only once
 * `TOOL_END_WRITE_MS` passed since the entry's last write.
 */
export function applyEvent(existing: RestoreEntry | undefined, event: TrackEvent, facts: TrackFacts): TrackChange {
  if (event.kind === 'end' && event.reason !== undefined && INTENTIONAL_END_REASONS.has(event.reason)) {
    return { kind: 'remove' };
  }
  if (event.kind === 'tool' && existing !== undefined && existing.endedAt === undefined && facts.at - existing.updatedAt < TOOL_END_WRITE_MS) {
    return { kind: 'none' };
  }
  const projectDir = existing?.projectDir ?? facts.projectDir;
  if (projectDir === undefined) {
    return { kind: 'none' };
  }
  const base: RestoreEntry = {
    claudeSession: facts.claudeSession,
    projectDir,
    transcriptPath: facts.transcriptPath ?? existing?.transcriptPath,
    entrypoint: facts.entrypoint ?? existing?.entrypoint,
    sessionKind: facts.sessionKind ?? existing?.sessionKind,
    pid: facts.pid ?? existing?.pid,
    team: facts.team ?? existing?.team,
    session: facts.session ?? existing?.session,
    state: existing?.state ?? 'ready',
    createdAt: existing?.createdAt ?? facts.at,
    updatedAt: facts.at,
    restoreAttempts: existing?.restoreAttempts ?? 0,
    restoredAt: existing?.restoredAt,
    endedAt: undefined,
    endReason: undefined,
  };
  switch (event.kind) {
    case 'end':
      return { kind: 'write', entry: { ...base, endedAt: facts.at, endReason: event.reason ?? OTHER_END } };
    case 'start':
      return { kind: 'write', entry: { ...base, state: 'ready', restoreAttempts: 0, restoredAt: undefined } };
    case 'tool':
      return { kind: 'write', entry: event.mainThread ? { ...base, state: 'working' } : base };
    case 'working':
    case 'ready':
    case 'error':
      return { kind: 'write', entry: { ...base, state: event.kind } };
  }
}

function isoOf(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** The entry as its file's JSON object: times as ISO instants, fields that are not set undefined, which JSON leaves out. */
export function entryRecord(entry: RestoreEntry): Readonly<Record<string, string | number | undefined>> {
  return {
    claudeSession: entry.claudeSession,
    projectDir: entry.projectDir,
    transcriptPath: entry.transcriptPath,
    entrypoint: entry.entrypoint,
    sessionKind: entry.sessionKind,
    pid: entry.pid,
    team: entry.team,
    session: entry.session,
    state: entry.state,
    createdAt: isoOf(entry.createdAt),
    updatedAt: isoOf(entry.updatedAt),
    restoreAttempts: entry.restoreAttempts,
    restoredAt: isoOf(entry.restoredAt),
    endedAt: isoOf(entry.endedAt),
    endReason: entry.endReason,
  };
}

/** The entry's file text: `entryRecord` as indented JSON. */
export function formatEntry(entry: RestoreEntry): string {
  return `${JSON.stringify(entryRecord(entry), null, 2)}\n`;
}

/** An optional instant; null when it is there but not an instant. */
function instantField(record: JsonRecord, key: string): number | undefined | null {
  if (record[key] === undefined) {
    return undefined;
  }
  const text = stringField(record, key);
  const ms = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

/** An optional team or session id, which a tab's command line carries; null when it is there but not an id. */
function idField(record: JsonRecord, key: string): string | undefined | null {
  if (record[key] === undefined) {
    return undefined;
  }
  const id = stringField(record, key);
  return id !== undefined && ID_PATTERN.test(id) ? id : null;
}

function activityOf(text: string | undefined): ActivityState | undefined {
  return ACTIVITY_STATES.find((state) => state === text);
}

/** An entry file's text; undefined when it is damaged or of another shape, which the restore then skips. */
export function parseEntry(text: string): RestoreEntry | undefined {
  const record = parseObject(text.trim());
  return record === undefined ? undefined : entryOfRecord(record);
}

/** The entry an `entryRecord` object holds; undefined when it is of another shape. */
export function entryOfRecord(record: JsonRecord): RestoreEntry | undefined {
  const claudeSession = stringField(record, 'claudeSession');
  const projectDir = stringField(record, 'projectDir');
  const state = activityOf(stringField(record, 'state'));
  const createdAt = instantField(record, 'createdAt');
  const updatedAt = instantField(record, 'updatedAt');
  const restoredAt = instantField(record, 'restoredAt');
  const endedAt = instantField(record, 'endedAt');
  const team = idField(record, 'team');
  const session = idField(record, 'session');
  const rawPid = record['pid'];
  const pid = rawPid === undefined ? undefined : isNonNegativeInteger(rawPid) ? rawPid : null;
  const restoreAttempts = record['restoreAttempts'];
  if (
    claudeSession === undefined ||
    !CLAUDE_SESSION_ID.test(claudeSession) ||
    projectDir === undefined ||
    state === undefined ||
    createdAt === undefined ||
    createdAt === null ||
    updatedAt === undefined ||
    updatedAt === null ||
    restoredAt === null ||
    endedAt === null ||
    team === null ||
    session === null ||
    !isNonNegativeInteger(restoreAttempts) ||
    pid === null
  ) {
    return undefined;
  }
  return {
    claudeSession,
    projectDir,
    transcriptPath: stringField(record, 'transcriptPath'),
    entrypoint: stringField(record, 'entrypoint'),
    sessionKind: stringField(record, 'sessionKind'),
    pid,
    team,
    session,
    state,
    createdAt,
    updatedAt,
    restoreAttempts,
    restoredAt,
    endedAt,
    endReason: stringField(record, 'endReason'),
  };
}
