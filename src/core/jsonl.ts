import { isNonNegativeInteger, isRecord, type JsonRecord } from './guards.ts';

/** The field every record written by this kit carries; a record without it is version 0. */
export const VERSION_FIELD = 'v';

export interface JsonlRecord {
  /** 1-based line number in the file. */
  readonly lineNumber: number;
  readonly raw: string;
  readonly record: JsonRecord;
  readonly version: number;
}

export interface JsonlParse {
  readonly records: readonly JsonlRecord[];
  /** Lines that are not a JSON object with a valid version: damaged, torn or foreign. Never fatal. */
  readonly unreadable: number;
}

/** Parses an append-only JSONL log. Blank lines are ignored; a damaged line is counted, never thrown. */
export function parseJsonl(text: string): JsonlParse {
  const records: JsonlRecord[] = [];
  let unreadable = 0;
  text.split('\n').forEach((line, index) => {
    const raw = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (raw.trim() === '') {
      return;
    }
    const record = parseObject(raw);
    const version = record === undefined ? undefined : recordVersion(record);
    if (record === undefined || version === undefined) {
      unreadable += 1;
      return;
    }
    records.push({ lineNumber: index + 1, raw, record, version });
  });
  return { records, unreadable };
}

/** The record's format version: 0 when the field is absent, undefined when it is present but invalid. */
export function recordVersion(record: JsonRecord): number | undefined {
  const version = record[VERSION_FIELD];
  if (version === undefined) {
    return 0;
  }
  return isNonNegativeInteger(version) ? version : undefined;
}

/** One whole JSONL line. JSON.stringify escapes newlines inside strings, so the line never splits. */
export function toJsonlLine(record: JsonRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** One line as a JSON object; undefined for anything else, a damaged or torn line included. */
export function parseObject(raw: string): JsonRecord | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Thrown before a write when the log already holds records newer than this code understands. */
export class NewerDataError extends Error {
  readonly file: string;
  readonly found: number;
  readonly known: number;

  constructor(file: string, found: number, known: number) {
    super(`${file} holds format v${found} records; this version writes v${known}. Update teamrig before writing.`);
    this.name = 'NewerDataError';
    this.file = file;
    this.found = found;
    this.known = known;
  }
}

/** Refuses a write beside records this code cannot interpret, so an old binary never mixes formats. */
export function assertWritable(file: string, parse: JsonlParse, knownVersion: number): void {
  const newest = parse.records.reduce((max, record) => Math.max(max, record.version), 0);
  if (newest > knownVersion) {
    throw new NewerDataError(file, newest, knownVersion);
  }
}

/**
 * A one-object file's record before it is rewritten; undefined for a missing or damaged file, which the write
 * may replace. A file in a newer format is refused, so an old binary never overwrites what a newer one wrote.
 */
export function writableObject(file: string, text: string | undefined, knownVersion: number): JsonRecord | undefined {
  const record = text === undefined ? undefined : parseObject(text.trim());
  const version = record === undefined ? undefined : recordVersion(record);
  if (version !== undefined && version > knownVersion) {
    throw new NewerDataError(file, version, knownVersion);
  }
  return record;
}
