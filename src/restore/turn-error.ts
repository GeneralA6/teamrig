import { stringField, type JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';

/**
 * The API error a failed turn ended on, as Claude Code names it (`authentication_failed`, `server_error`,
 * `overloaded`, ...). A StopFailure payload carries it as `error`; one that does not leaves only the turn's last
 * transcript record, the synthetic error message Claude Code writes in the model's place.
 */

/** How much of a transcript's end is read for the error record of a turn that failed: it is the turn's last record. */
export const TURN_TAIL_BYTES = 64 * 1024;

/**
 * The error a StopFailure ended its turn on. The payload's `error` decides it; only a payload with none reads the
 * transcript's end (`tailOf`, undefined when there is none). Undefined when neither names one.
 */
export async function turnErrorOf(payload: JsonRecord, tailOf: () => Promise<string | undefined>): Promise<string | undefined> {
  const error = stringField(payload, 'error');
  if (error !== undefined) {
    return error;
  }
  const tail = await tailOf();
  return tail === undefined ? undefined : lastAssistantErrorOf(tail);
}

/**
 * The error of the last assistant record of `text` when it is an API error message; undefined when it is a model
 * answer (the turn that failed is an older one) or there is none. A torn first line, as a tail cut mid-record leaves
 * it, is skipped.
 */
function lastAssistantErrorOf(text: string): string | undefined {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    const record = line.includes('"assistant"') ? parseObject(line) : undefined;
    if (record?.['type'] === 'assistant') {
      return record['isApiErrorMessage'] === true ? stringField(record, 'error') : undefined;
    }
  }
  return undefined;
}
