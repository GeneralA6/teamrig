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
 *   then (null: there was none), so `refresh --ready` can tell a new handover from an old one. `midTurn` when
 *   the plugin's mod asked at a tool result within a turn rather than the Stop hook at its end: the turn's end
 *   asks once more when the handover is not marked ready by then (a file from before it has none: false).
 * - `ready`: its handover is written and it waits for a fresh start (the automatic restart, or the user's
 *   /clear); `noticed` once the user was told. `transcript` is the Claude Code transcript of the session that
 *   wrote it, recorded with the notice (null before, or when Claude Code gave none): the fresh start reads
 *   from it what that session leaves to take over. `claudePid` is the Claude Code process the notice was
 *   given in (null before, or when it was not found): a /clear keeps the process, so the fresh tab binds by it.
 * - `refreshed`: a fresh start was pointed at the handover.
 * In `asked`, `ready` and `refreshed`, `task` is the task whose end asked for the refresh, null when another
 * turn end asked. In `asked` and `ready`, `tokens` is the context the refresh was asked at, null when unknown or
 * when the context was made small since (a compaction, a /clear): a session that goes on without its fresh
 * start is asked again only once its context grew well past it.
 */
export type RefreshState =
  | { readonly phase: 'boundary'; readonly task: string; readonly at: string; readonly finished: number }
  | { readonly phase: 'idle'; readonly task: string; readonly at: string; readonly tokens: number | null; readonly finished: number }
  | {
      readonly phase: 'asked';
      readonly task: string | null;
      readonly at: string;
      readonly tokens: number | null;
      readonly handoverHash: string | null;
      readonly midTurn: boolean;
    }
  | {
      readonly phase: 'ready';
      readonly task: string | null;
      readonly at: string;
      readonly tokens: number | null;
      readonly noticed: boolean;
      readonly transcript: string | null;
      readonly claudePid: number | null;
    }
  | { readonly phase: 'refreshed'; readonly task: string | null; readonly at: string };

/** The lead's ask that a session refresh at its next finished task, whatever its context. */
export interface RefreshRequest {
  /** The lead's session id. */
  readonly by: string;
  readonly at: string;
}

/**
 * The automatic restart the Stop hook asked for once the handover was written (`refresh.autoRestart`):
 * `pending` while it waits out its delay and for the tab's mod to claim its /clear ask (the claim clears the
 * request), `ending` once the session's process is being ended instead, which tells `teamrig launch` to start
 * it again.
 */
export interface RestartRequest {
  readonly phase: 'pending' | 'ending';
  /** When the Stop hook asked: the restart started for it acts only on this request, never on a later one. */
  readonly at: string;
  /** The Claude Code process to end when no mod clears the tab: the one the Stop hook runs under. */
  readonly pid: number;
  /** Its Claude Code session id: the tab's mod finds its ask by it, and the SessionEnd input of `refresh.endCommand` names it. */
  readonly claudeSession: string;
  readonly transcript: string | null;
  readonly cwd: string | null;
  /** `teamrig launch` runs the process and starts it again; otherwise the restart opens a new tab. */
  readonly supervised: boolean;
}

/** What a restart keeps of the tab it is for, from the Stop hook that asked for it. */
export type RestartTab = Pick<RestartRequest, 'claudeSession' | 'transcript' | 'cwd' | 'supervised'>;

/**
 * The automatic restart the Stop hook held back once the handover was written (T1383): the session had no work it
 * could start, so a fresh start then would only read the handover and sit idle. The next wake that brings it work
 * (`hook wake-check`, in the tab named) arms the restart from this record instead of waking the session; a prompt or a
 * later turn end drops it, the session having gone on from its context.
 */
export interface ParkedRestart extends RestartTab {
  /** When the Stop hook held it back. */
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
  // Only a task end names its task: a refresh another turn end asked for has none.
  const task = record === undefined ? undefined : nullableString(record, 'task');
  const at = record === undefined ? undefined : stringField(record, 'at');
  if (record === undefined || task === undefined || at === undefined) {
    return undefined;
  }
  switch (record['phase']) {
    case 'boundary': {
      const finished = finishedOf(record, 1);
      return task === null || finished === undefined ? undefined : { phase: 'boundary', task, at, finished };
    }
    case 'idle': {
      const tokens = tokensOf(record);
      const finished = finishedOf(record, 0);
      return task === null || tokens === undefined || finished === undefined ? undefined : { phase: 'idle', task, at, tokens, finished };
    }
    case 'asked': {
      const tokens = tokensOf(record);
      const handoverHash = hashOf(record);
      // A file from before the mod asked within a turn was always the Stop hook's.
      const midTurn = record['midTurn'] ?? false;
      return tokens === undefined || handoverHash === undefined || typeof midTurn !== 'boolean'
        ? undefined
        : { phase: 'asked', task, at, tokens, handoverHash, midTurn };
    }
    case 'ready': {
      const noticed = record['noticed'];
      // A file from before the transcript was recorded has none.
      const transcript = record['transcript'] === undefined ? null : nullableString(record, 'transcript');
      const claudePid = nullablePidOf(record['claudePid']);
      // A file from before the size was recorded has none.
      const tokens = record['tokens'] === undefined ? null : tokensOf(record);
      return typeof noticed === 'boolean' && transcript !== undefined && claudePid !== undefined && tokens !== undefined
        ? { phase: 'ready', task, at, tokens, noticed, transcript, claudePid }
        : undefined;
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
  const tab = restartTabOf(record);
  if ((phase !== 'pending' && phase !== 'ending') || at === undefined || !isNonNegativeInteger(pid) || pid === 0 || tab === undefined) {
    return undefined;
  }
  return { phase, at, pid, ...tab };
}

export function formatRestartRequest(request: RestartRequest): string {
  return toJsonlLine({ [VERSION_FIELD]: REFRESH_FORMAT, ...request });
}

/** A parked restart file's content; undefined when it is damaged or from another format. */
export function parseParkedRestart(text: string): ParkedRestart | undefined {
  const record = recordOf(text);
  if (record === undefined) {
    return undefined;
  }
  const at = stringField(record, 'at');
  const tab = restartTabOf(record);
  return at === undefined || tab === undefined ? undefined : { at, ...tab };
}

export function formatParkedRestart(parked: ParkedRestart): string {
  return toJsonlLine({ [VERSION_FIELD]: REFRESH_FORMAT, ...parked });
}

/** The tab fields of a restart file; undefined when one is missing or of the wrong type. */
function restartTabOf(record: JsonRecord): RestartTab | undefined {
  const claudeSession = stringField(record, 'claudeSession');
  const transcript = nullableString(record, 'transcript');
  const cwd = nullableString(record, 'cwd');
  const supervised = record['supervised'];
  if (claudeSession === undefined || transcript === undefined || cwd === undefined || typeof supervised !== 'boolean') {
    return undefined;
  }
  return { claudeSession, transcript, cwd, supervised };
}
