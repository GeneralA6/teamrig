import { isNonNegativeInteger, stringField, type JsonRecord } from '../core/guards.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';

/** The format of the refresh files this code reads and writes; a file in another format reads as absent. */
export const REFRESH_FORMAT = 1;

/**
 * Where a session is in the context-refresh flow, one small file per session:
 * - `boundary`: it finished `task` (`set <task> --status done`); its Stop hook has not judged it yet.
 * - `idle`: judged with no refresh due; `tokens` is its context then, null when the transcript had no usage.
 * - `boundary` and `idle` count in `finished` the tasks finished since the context was last fresh (a /clear,
 *   a new process or a compaction), this one included.
 * - `asked`: its Stop hook asked it to write its handover; `handoverHash` fingerprints the handover file
 *   then (null: there was none), so `refresh --ready` can tell a new handover from an old one.
 * - `ready`: its handover is written and it waits for the user's /clear; `noticed` once the user was told.
 * - `refreshed`: a fresh start was pointed at the handover.
 */
export type RefreshState =
  | { readonly phase: 'boundary'; readonly task: string; readonly at: string; readonly finished: number }
  | { readonly phase: 'idle'; readonly task: string; readonly at: string; readonly tokens: number | null; readonly finished: number }
  | { readonly phase: 'asked'; readonly task: string; readonly at: string; readonly tokens: number | null; readonly handoverHash: string | null }
  | { readonly phase: 'ready'; readonly task: string; readonly at: string; readonly noticed: boolean }
  | { readonly phase: 'refreshed'; readonly task: string; readonly at: string };

/** The lead's ask that a session refresh at its next finished task, whatever its context. */
export interface RefreshRequest {
  /** The lead's session id. */
  readonly by: string;
  readonly at: string;
}

/** A file of this format as an object; undefined for a damaged file or one in another format. */
function recordOf(text: string): JsonRecord | undefined {
  const record = parseObject(text.trim());
  return record !== undefined && record[VERSION_FIELD] === REFRESH_FORMAT ? record : undefined;
}

function tokensOf(record: JsonRecord): number | null | undefined {
  const tokens = record['tokens'];
  return tokens === null || isNonNegativeInteger(tokens) ? tokens : undefined;
}

/** The task count; a file from before the count has none and reads as `absent`, a wrong value as undefined. */
function finishedOf(record: JsonRecord, absent: number): number | undefined {
  const finished = record['finished'];
  if (finished === undefined) {
    return absent;
  }
  return isNonNegativeInteger(finished) ? finished : undefined;
}

function hashOf(record: JsonRecord): string | null | undefined {
  const hash = record['handoverHash'];
  return hash === null || typeof hash === 'string' ? hash : undefined;
}

/** A refresh state file's content; undefined when it is damaged, from another format or names no known phase. */
export function parseRefreshState(text: string): RefreshState | undefined {
  const record = recordOf(text);
  const task = record === undefined ? undefined : stringField(record, 'task');
  const at = record === undefined ? undefined : stringField(record, 'at');
  if (record === undefined || task === undefined || at === undefined) {
    return undefined;
  }
  switch (record['phase']) {
    case 'boundary': {
      const finished = finishedOf(record, 1);
      return finished === undefined ? undefined : { phase: 'boundary', task, at, finished };
    }
    case 'idle': {
      const tokens = tokensOf(record);
      const finished = finishedOf(record, 0);
      return tokens === undefined || finished === undefined ? undefined : { phase: 'idle', task, at, tokens, finished };
    }
    case 'asked': {
      const tokens = tokensOf(record);
      const handoverHash = hashOf(record);
      return tokens === undefined || handoverHash === undefined ? undefined : { phase: 'asked', task, at, tokens, handoverHash };
    }
    case 'ready': {
      const noticed = record['noticed'];
      return typeof noticed === 'boolean' ? { phase: 'ready', task, at, noticed } : undefined;
    }
    case 'refreshed':
      return { phase: 'refreshed', task, at };
    default:
      return undefined;
  }
}

export function formatRefreshState(state: RefreshState): string {
  return toJsonlLine({ [VERSION_FIELD]: REFRESH_FORMAT, ...state });
}

/** A request file's content; undefined when it is damaged or from another format. */
export function parseRefreshRequest(text: string): RefreshRequest | undefined {
  const record = recordOf(text);
  const by = record === undefined ? undefined : stringField(record, 'by');
  const at = record === undefined ? undefined : stringField(record, 'at');
  return by === undefined || at === undefined ? undefined : { by, at };
}

export function formatRefreshRequest(request: RefreshRequest): string {
  return toJsonlLine({ [VERSION_FIELD]: REFRESH_FORMAT, ...request });
}
