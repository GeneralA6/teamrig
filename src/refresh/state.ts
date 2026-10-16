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
 * - `ready`: its handover is written and it waits for a fresh start (the automatic restart, or the user's
 *   /clear); `noticed` once the user was told. `transcript` is the Claude Code transcript of the session that
 *   wrote it, recorded with the notice (null before, or when Claude Code gave none): the fresh start reads
 *   from it what that session leaves to take over. `claudePid` is the Claude Code process the notice was
 *   given in (null before, or when it was not found): a /clear keeps the process, so the fresh tab binds by it.
 * - `refreshed`: a fresh start was pointed at the handover.
 */
export type RefreshState =
  | { readonly phase: 'boundary'; readonly task: string; readonly at: string; readonly finished: number }
  | { readonly phase: 'idle'; readonly task: string; readonly at: string; readonly tokens: number | null; readonly finished: number }
  | { readonly phase: 'asked'; readonly task: string; readonly at: string; readonly tokens: number | null; readonly handoverHash: string | null }
  | { readonly phase: 'ready'; readonly task: string; readonly at: string; readonly noticed: boolean; readonly transcript: string | null; readonly claudePid: number | null }
  | { readonly phase: 'refreshed'; readonly task: string; readonly at: string };

/** The lead's ask that a session refresh at its next finished task, whatever its context. */
export interface RefreshRequest {
  /** The lead's session id. */
  readonly by: string;
  readonly at: string;
}

/**
 * The automatic restart the Stop hook asked for once the handover was written (`refresh.autoRestart`):
 * `pending` while it waits out its delay, `ending` once the session's process is being ended, which tells
 * `teamrig launch` to start it again.
 */
export interface RestartRequest {
  readonly phase: 'pending' | 'ending';
  /** When the Stop hook asked: the restart started for it acts only on this request, never on a later one. */
  readonly at: string;
  /** The Claude Code process to end: the one the Stop hook runs under. */
  readonly pid: number;
  /** Its Claude Code session id, for the SessionEnd input of `refresh.endCommand`. */
  readonly claudeSession: string;
  readonly transcript: string | null;
  readonly cwd: string | null;
  /** `teamrig launch` runs the process and starts it again; otherwise the restart opens a new tab. */
  readonly supervised: boolean;
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
      // A file from before the transcript was recorded has none.
      const transcript = record['transcript'] === undefined ? null : nullableString(record, 'transcript');
      const claudePid = nullablePidOf(record['claudePid']);
      return typeof noticed === 'boolean' && transcript !== undefined && claudePid !== undefined ? { phase: 'ready', task, at, noticed, transcript, claudePid } : undefined;
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

/** A process id, null when absent or null, undefined when damaged. */
function nullablePidOf(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  return isNonNegativeInteger(value) && value > 0 ? value : undefined;
}

function nullableString(record: JsonRecord, key: string): string | null | undefined {
  const value = record[key];
  return value === null || typeof value === 'string' ? value : undefined;
}

/** A restart file's content; undefined when it is damaged or from another format. */
export function parseRestartRequest(text: string): RestartRequest | undefined {
  const record = recordOf(text);
  if (record === undefined) {
    return undefined;
  }
  const phase = record['phase'];
  const at = stringField(record, 'at');
  const pid = record['pid'];
  const claudeSession = stringField(record, 'claudeSession');
  const transcript = nullableString(record, 'transcript');
  const cwd = nullableString(record, 'cwd');
  const supervised = record['supervised'];
  if (
    (phase !== 'pending' && phase !== 'ending') ||
    at === undefined ||
    !isNonNegativeInteger(pid) ||
    pid === 0 ||
    claudeSession === undefined ||
    transcript === undefined ||
    cwd === undefined ||
    typeof supervised !== 'boolean'
  ) {
    return undefined;
  }
  return { phase, at, pid, claudeSession, transcript, cwd, supervised };
}

export function formatRestartRequest(request: RestartRequest): string {
  return toJsonlLine({ [VERSION_FIELD]: REFRESH_FORMAT, ...request });
}
