/** Runtime type guards for untrusted JSON (config, logs, hook input). Narrow, never cast. */
export type JsonRecord = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** The field as a finite number; undefined when it is absent, not a number, NaN or infinite. */
export function numberField(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The field as an instant (ms since the epoch) from the ISO text a file keeps; undefined when it is absent or no instant. */
export function instantField(record: JsonRecord, key: string): number | undefined {
  const text = stringField(record, key);
  const ms = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
}

export function recordField(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `code` of a Node system error (ENOENT, EEXIST, ...), if any. */
export function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error['code'] === 'string' ? error['code'] : undefined;
}
