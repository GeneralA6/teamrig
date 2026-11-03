import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isRecord, isStringArray, stringField, type JsonRecord } from '../core/guards.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import type { DayMomentKind } from './day-start.ts';
import { NO_SETTLED_MOMENTS, type SettledMoments, type WakeCost, type WakePending, type WakeState } from './decide.ts';

/** The format of the wake files this code reads and writes; a file in another format reads as no check yet. */
export const WAKE_FORMAT = 1;

function finiteField(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A stored pending batch: absent is none; damage is undefined, so the whole file reads as damaged. */
function pendingOf(record: JsonRecord): { readonly ok: boolean; readonly value: WakePending | undefined } {
  const raw = record['pending'];
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  const pending = isRecord(raw) ? raw : undefined;
  const since = pending === undefined ? undefined : finiteField(pending, 'since');
  const ids = pending?.['ids'];
  return since !== undefined && isStringArray(ids) ? { ok: true, value: { since, ids } } : { ok: false, value: undefined };
}

/** A stored time that may be absent: absent is undefined; damage is not ok, so the whole file reads as damaged. */
function optionalTimeOf(record: JsonRecord, key: string): { readonly ok: boolean; readonly value: number | undefined } {
  if (record[key] === undefined) {
    return { ok: true, value: undefined };
  }
  const value = finiteField(record, key);
  return { ok: value !== undefined, value };
}

/** The stored settled moments: absent (a file from before day starts) is none; damage is not ok. */
function settledOf(record: JsonRecord): { readonly ok: boolean; readonly value: SettledMoments } {
  const raw = record['settled'];
  if (raw === undefined) {
    return { ok: true, value: NO_SETTLED_MOMENTS };
  }
  if (!isRecord(raw)) {
    return { ok: false, value: NO_SETTLED_MOMENTS };
  }
  const dayStart = optionalTimeOf(raw, 'dayStart');
  const burst = optionalTimeOf(raw, 'burst');
  return { ok: dayStart.ok && burst.ok, value: { dayStart: dayStart.value, burst: burst.value } };
}

/** A wake file's content; undefined when it is damaged or from another format, which starts the tab over. */
export function parseWakeState(text: string): WakeState | undefined {
  const record = parseObject(text.trim());
  if (record === undefined || record[VERSION_FIELD] !== WAKE_FORMAT) {
    return undefined;
  }
  const tab = stringField(record, 'tab');
  const known = record['known'];
  const pending = pendingOf(record);
  const last = optionalTimeOf(record, 'lastWakeAt');
  const settled = settledOf(record);
  if (tab === undefined || !isStringArray(known) || !pending.ok || !last.ok || !settled.ok) {
    return undefined;
  }
  return { tab, known, pending: pending.value, lastWakeAt: last.value, settled: settled.value };
}

function formatSettled({ dayStart, burst }: SettledMoments): JsonRecord {
  return { ...(dayStart === undefined ? {} : { dayStart }), ...(burst === undefined ? {} : { burst }) };
}

export function formatWakeState(state: WakeState): string {
  const settled = formatSettled(state.settled);
  return toJsonlLine({
    [VERSION_FIELD]: WAKE_FORMAT,
    tab: state.tab,
    known: [...state.known],
    ...(state.pending === undefined ? {} : { pending: { since: state.pending.since, ids: [...state.pending.ids] } }),
    ...(state.lastWakeAt === undefined ? {} : { lastWakeAt: state.lastWakeAt }),
    ...(Object.keys(settled).length === 0 ? {} : { settled }),
  });
}

/**
 * What the wake check kept for each team session, one small file per session (`<id>.json`), written under the
 * session's wake lock. Ids are session ids, checked by the roster, so they are safe in a path.
 */
export class WakeStore {
  private readonly files: Files;
  private readonly folder: string;

  constructor(files: Files, folder: string) {
    this.files = files;
    this.folder = folder;
  }

  async read(id: string): Promise<WakeState | undefined> {
    const text = await this.files.read(this.pathOf(id));
    return text === undefined ? undefined : parseWakeState(text);
  }

  async write(id: string, state: WakeState): Promise<void> {
    await this.files.write(this.pathOf(id), formatWakeState(state));
  }

  /** The lock held while one tab of the session checks, so two tabs of it never wake it twice. */
  lockOf(id: string): string {
    return join(this.folder, `${id}.lock`);
  }

  private pathOf(id: string): string {
    return join(this.folder, `${id}.json`);
  }
}

/**
 * One line of the wake log: a wake submitted, for work handed to the session, with `asks` for that many urgent lines
 * (src/wake/asks.ts), with `moments` for the day's moments (src/wake/day-start.ts), or with `retry` for a turn sent
 * again after it ended on an expired login (src/wake/login-retry.ts); or one Claude Code dropped.
 */
export type WakeRecord =
  | {
      readonly kind: 'wake';
      readonly at: number;
      readonly session: string;
      readonly tab: string;
      readonly ids: readonly string[];
      readonly cost: WakeCost;
      readonly asks?: number;
      readonly moments?: readonly DayMomentKind[];
      readonly retry?: 'login';
    }
  | { readonly kind: 'dropped'; readonly at: number; readonly session: string; readonly tab: string; readonly reason: string };

/** The format of the wake log's lines. */
export const WAKE_LOG_FORMAT = 1;

/** The wake log's line for a record. */
export function formatWakeRecord(record: WakeRecord): string {
  const base = { [VERSION_FIELD]: WAKE_LOG_FORMAT, at: new Date(record.at).toISOString(), kind: record.kind, session: record.session, tab: record.tab };
  if (record.kind === 'dropped') {
    return toJsonlLine({ ...base, reason: record.reason });
  }
  const { cost } = record;
  return toJsonlLine({
    ...base,
    ids: [...record.ids],
    w: cost.w,
    cold: cost.cold,
    ...(cost.weekPct === undefined ? {} : { weekPct: cost.weekPct }),
    ...(record.asks === undefined ? {} : { asks: record.asks }),
    ...(record.moments === undefined ? {} : { moments: [...record.moments] }),
    ...(record.retry === undefined ? {} : { retry: record.retry }),
  });
}

/** Appends a record to the team's wake log, an append-only file the person reads to see each wake and its cost. */
export async function logWake(files: Files, path: string, record: WakeRecord): Promise<void> {
  await files.append(path, formatWakeRecord(record));
}
