export type JsonRecord = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function recordField(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}
