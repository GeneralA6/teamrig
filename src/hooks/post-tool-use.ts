import { isRecord, type JsonRecord } from '../core/guards.ts';

/** The tool's result as a record: Claude Code may hand it over as the object or as its JSON text. */
export function toolResponseOf(value: unknown): JsonRecord | undefined {
  if (typeof value !== 'string') {
    return isRecord(value) ? value : undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
