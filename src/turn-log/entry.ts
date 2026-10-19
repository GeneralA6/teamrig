import { stringField, type JsonRecord } from '../core/guards.ts';
import { recordVersion, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';

/** The format version of a turn log line. */
export const TURN_LOG_VERSION = 1;

/** The most text one entry keeps: a longer reply keeps its end, where the turn's answer is. */
export const MAX_TEXT_CHARS = 64_000;

/** What a line records: the prompt the person sent, the reply the session showed, or a clear or compaction of its context. */
export type TurnLogKind = 'prompt' | 'reply' | 'clear';

const KINDS: ReadonlySet<string> = new Set<TurnLogKind>(['prompt', 'reply', 'clear']);

function isKind(value: string | undefined): value is TurnLogKind {
  return value !== undefined && KINDS.has(value);
}

/**
 * One line of a session's turn log, the contract the task pane reads: an append-only JSON line in
 * `<team state>/turn-log/<session id>/<UTC hour>.jsonl`. Readers ignore fields they do not know.
 */
export interface TurnLogEntry {
  /** When it happened, ISO UTC. */
  readonly at: string;
  readonly kind: TurnLogKind;
  /** Secret shapes redacted; at most MAX_TEXT_CHARS. */
  readonly text: string;
  /** The Claude Code session it came from; a /clear starts a new one in the same tab. */
  readonly claude: string;
  /** The text was cut to MAX_TEXT_CHARS, or the reply began before the part of the transcript teamrig read. */
  readonly truncated?: true;
  /** A reply's last transcript entry (its `uuid`): a later reply of the same turn starts after it. */
  readonly upTo?: string;
}

/** `text` cut to its last MAX_TEXT_CHARS, with whether it was cut. */
export function cappedText(text: string): { readonly text: string; readonly cut: boolean } {
  return text.length > MAX_TEXT_CHARS ? { text: text.slice(-MAX_TEXT_CHARS), cut: true } : { text, cut: false };
}

/** The entry as one JSONL line, versioned. */
export function formatEntry(entry: TurnLogEntry): string {
  return toJsonlLine({ [VERSION_FIELD]: TURN_LOG_VERSION, ...entry });
}

/** A parsed line as an entry; undefined for a line of a newer version or one missing a field. */
export function parseEntry(record: JsonRecord): TurnLogEntry | undefined {
  if (recordVersion(record) !== TURN_LOG_VERSION) {
    return undefined;
  }
  const at = stringField(record, 'at');
  const kind = stringField(record, 'kind');
  const text = stringField(record, 'text');
  const claude = stringField(record, 'claude');
  if (at === undefined || !isKind(kind) || text === undefined || claude === undefined) {
    return undefined;
  }
  const upTo = stringField(record, 'upTo');
  return {
    at,
    kind,
    text,
    claude,
    ...(record['truncated'] === true ? { truncated: true } : {}),
    ...(upTo === undefined ? {} : { upTo }),
  };
}
