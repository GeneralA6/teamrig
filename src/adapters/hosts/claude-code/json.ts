import { isRecord, type JsonRecord } from '../../../plugin-api/index.ts';

/** A text as the JSON object it holds, spaces around it left out; undefined when it is not JSON or holds no object. */
export function objectOf(text: string): JsonRecord | undefined {
  try {
    const value: unknown = JSON.parse(text.trim());
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
