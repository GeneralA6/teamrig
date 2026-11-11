import { join } from 'node:path';
import { isEffortLevel, type EffortLevel } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import { isRecord, numberField, stringField, type JsonRecord } from '../core/guards.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import type { Clock } from '../core/lock.ts';
import type { TimeZone } from '../core/zone.ts';
import { RUNNING_TAIL_BYTES } from '../refresh/running.ts';
import { typedEffortsOf, type TypedEffort } from './typed-effort.ts';

/** The format of the marks files this code reads and writes; a file in another format reads as none. */
export const WRITEBACK_MARKS_FORMAT = 1;

/** How far a session's typed `/effort` lines were taken up, and the config level it had then. */
export interface WritebackMarks {
  /** Every typed `/effort` up to this instant (epoch ms) is taken up: written back, or passed over for a newer decision. */
  readonly lastAt: number;
  /** The last typed entry taken up; undefined before the first. */
  readonly uuid: string | undefined;
  /** The session's config level when last looked at; null when the config sets none. */
  readonly config: EffortLevel | null;
}

export function parseWritebackMarks(text: string): WritebackMarks | undefined {
  const record = parseObject(text.trim());
  if (record === undefined || record[VERSION_FIELD] !== WRITEBACK_MARKS_FORMAT) {
    return undefined;
  }
  const lastAt = numberField(record, 'lastAt');
  const config = record['config'];
  if (lastAt === undefined || (config !== null && !isEffortLevel(config))) {
    return undefined;
  }
  return { lastAt, uuid: stringField(record, 'uuid'), config };
}

export function formatWritebackMarks(marks: WritebackMarks): string {
  return toJsonlLine({ [VERSION_FIELD]: WRITEBACK_MARKS_FORMAT, lastAt: marks.lastAt, uuid: marks.uuid, config: marks.config });
}

/**
 * Each team session's marks, one small file per session (`<id>.json`), written only by that session's own hooks.
 * Ids are session ids, checked by the roster, so they are safe in a path.
 */
export class WritebackMarksStore {
  private readonly files: Files;
  private readonly dir: string;

  constructor(files: Files, dir: string) {
    this.files = files;
    this.dir = dir;
  }

  /** The session's marks; undefined before its first look, or for a damaged file, which the next save replaces. */
  async read(id: string): Promise<WritebackMarks | undefined> {
    const text = await this.files.read(this.pathOf(id));
    return text === undefined ? undefined : parseWritebackMarks(text);
  }

  save(id: string, marks: WritebackMarks): Promise<void> {
    return this.files.write(this.pathOf(id), formatWritebackMarks(marks));
  }

  private pathOf(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}

/**
 * The config file's JSON with only the session's `launch` effort set to `level`; every other key, its own launch
 * keys included, stays as it was. The launch entry is made when the session has none.
 */
export function withLaunchEffort(file: JsonRecord, id: string, level: EffortLevel): JsonRecord {
  const launch = isRecord(file['launch']) ? file['launch'] : {};
  // By its own keys only, so an id such as `constructor` never reads the object's prototype.
  const own = Object.entries(launch).find(([key]) => key === id)?.[1];
  return { ...file, launch: { ...launch, [id]: { ...(isRecord(own) ? own : {}), effort: level } } };
}

/** A level a typed `/effort` wrote to the config. */
export interface WrittenEffort {
  /** The level the config gave the session before; undefined when it gave none. */
  readonly from: EffortLevel | undefined;
  readonly to: EffortLevel;
  /** Where the old config was kept. */
  readonly backup: string;
}

/** What a hook knows of the session when it looks for a typed `/effort`. */
export interface WritebackInput {
  /** The team session's id. */
  readonly id: string;
  /** The Claude Code session id; only its own transcript lines count. */
  readonly claude: string;
  /** The payload's transcript path; undefined when it gives none. */
  readonly transcript: string | undefined;
  /** The level the payload says runs (Stop has it); undefined when it says none (SessionEnd). */
  readonly running: string | undefined;
  /** The session's level in the config as loaded (`launchOf`); undefined when it sets none. */
  readonly config: EffortLevel | undefined;
}

export interface WritebackDeps {
  readonly files: Files;
  readonly clock: Clock;
  readonly marks: WritebackMarksStore;
  /** When the config file last changed; undefined when it cannot be told. */
  readonly configChangedAt: () => Promise<number | undefined>;
  /**
   * Sets the session's launch effort to `level` under the config lock, read afresh there; undefined when the config
   * already has it then. Throws when the change cannot be written (a config with a problem, the lock not got).
   */
  readonly write: (level: EffortLevel) => Promise<WrittenEffort | undefined>;
}

/** A write-back done: the typed entry it came from, and what changed. */
export interface Writeback {
  readonly typed: TypedEffort;
  readonly written: WrittenEffort;
}

function newestAfter(typed: readonly TypedEffort[], lastAt: number): TypedEffort | undefined {
  return typed.filter((entry) => entry.at > lastAt).at(-1);
}

function sameMarks(a: WritebackMarks, b: WritebackMarks): boolean {
  return a.lastAt === b.lastAt && a.uuid === b.uuid && a.config === b.config;
}

/**
 * Writes the level of the newest `/effort` the user typed in the session back to its `launch` entry, so a restore or
 * a restart opens it at that level (T2441). A turn that runs at the config's level reads no transcript. Typing before
 * the session's first look never applies (an old `/effort` in a resumed transcript), nor typing before the config
 * changed the session's level, which is the newer decision; a typed level the session no longer runs at is taken up
 * without a write. Each typed entry is taken up once, written back or not.
 */
export async function effortWriteback(deps: WritebackDeps, input: WritebackInput): Promise<Writeback | undefined> {
  const config = input.config ?? null;
  const marks = await deps.marks.read(input.id);
  if (marks === undefined) {
    await deps.marks.save(input.id, { lastAt: deps.clock.now(), uuid: undefined, config });
    return undefined;
  }
  const lastAt = marks.config === config ? marks.lastAt : Math.max(marks.lastAt, (await deps.configChangedAt()) ?? deps.clock.now());
  const seen: WritebackMarks = { ...marks, lastAt, config };
  const runsAsConfigured = isEffortLevel(input.running) && input.running === input.config;
  const text = runsAsConfigured || input.transcript === undefined ? undefined : await deps.files.readTail(input.transcript, RUNNING_TAIL_BYTES);
  const typed = text === undefined ? undefined : newestAfter(typedEffortsOf(text, input.claude), lastAt);
  if (typed === undefined) {
    if (!sameMarks(seen, marks)) {
      await deps.marks.save(input.id, seen);
    }
    return undefined;
  }
  const stillRuns = !isEffortLevel(input.running) || input.running === typed.level;
  const written = stillRuns && typed.level !== input.config ? await deps.write(typed.level) : undefined;
  await deps.marks.save(input.id, { lastAt: typed.at, uuid: typed.uuid, config: written === undefined ? config : written.to });
  return written === undefined ? undefined : { typed, written };
}

/** A write-back's line in the effort change log. */
export function effortChangeLine(at: number, id: string, claude: string, change: Writeback): string {
  const { typed, written } = change;
  return toJsonlLine({
    [VERSION_FIELD]: 1,
    at: new Date(at).toISOString(),
    session: id,
    from: written.from ?? null,
    to: written.to,
    claude,
    uuid: typed.uuid,
    typedAt: new Date(typed.at).toISOString(),
    backup: written.backup,
  });
}

/** The inbox line that tells the session's leader of a write-back. */
export function effortChangeText(name: string, team: string, change: Writeback, zone: TimeZone): string {
  const { typed, written } = change;
  return `${name} effort ${written.from ?? 'unset'} -> ${written.to} (a typed /effort at ${zone.clock(new Date(typed.at))}), written to its launch entry in the ${team} config`;
}
