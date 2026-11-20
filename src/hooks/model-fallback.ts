import type { Files } from '../core/files.ts';
import type { EntryKind, TranscriptReader } from '../ports/host/index.ts';

/**
 * A model switch the host made on its own and wrote to the session's transcript: its safeguards
 * stopped a reply on `from`, so it retried on `to` and answers on `to` for the rest of the session.
 * The transcript reader gives it as a `model-switch` entry; the host's hook payloads name no model.
 */
export interface ModelFallback {
  /** The entry's id, which tells this switch from a later one. */
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** The safeguard's category, such as `cyber`; undefined when the entry gives none. */
  readonly category: string | undefined;
}

/**
 * How much of the transcript's end the Stop hook reads for a switch. The host writes the switch
 * when it happens, so a long turn's tool calls come after it before the turn's Stop.
 */
export const FALLBACK_TAIL_BYTES = 1024 * 1024;

/** The entries the walk reads until it knows the model of the latest reply, and the only kind it reads after. */
const KINDS: readonly EntryKind[] = ['model-switch', 'reply'];
const SWITCH: readonly EntryKind[] = ['model-switch'];

/**
 * The session's last switch in transcript lines, while it still holds: undefined when there is none,
 * or a later main-thread reply came from another model (the user switched back). A reply the host made
 * up itself names no model that answered, so it decides nothing. A `cut` text, the tail of a longer
 * file, may start mid-line, so its first line is skipped; damaged lines are skipped too.
 */
export function lastFallbackOf(reader: TranscriptReader, text: string, cut: boolean): ModelFallback | undefined {
  const lines = text.split('\n');
  const first = cut ? 1 : 0;
  let latestModel: string | undefined;
  for (let index = lines.length - 1; index >= first; index -= 1) {
    const entry = reader.entry(lines[index] ?? '', latestModel === undefined ? KINDS : SWITCH);
    if (entry === undefined || entry.kind === 'unread' || entry.thread === 'helper') {
      continue;
    }
    if (entry.kind === 'reply') {
      latestModel ??= entry.synthetic ? undefined : entry.model;
      continue;
    }
    if (entry.kind !== 'model-switch' || entry.from === undefined || entry.from === entry.to) {
      continue;
    }
    const { from, to } = entry;
    return latestModel === undefined || latestModel === to ? { id: entry.id ?? `${from}>${to}`, from, to, category: entry.reason } : undefined;
  }
  return undefined;
}

/** The last switch from the transcript's last `FALLBACK_TAIL_BYTES`, never the whole file; undefined when the transcript is missing. */
export async function readLastFallback(reader: TranscriptReader, files: Files, transcript: string): Promise<ModelFallback | undefined> {
  const text = await files.readTail(transcript, FALLBACK_TAIL_BYTES);
  return text === undefined ? undefined : lastFallbackOf(reader, text, Buffer.byteLength(text, 'utf8') >= FALLBACK_TAIL_BYTES);
}

/**
 * The line that tells the user the host switched the session's model, with the command that
 * switches back: to `wanted`, the team config's model, else the model the session ran before.
 */
export function fallbackLine(name: string, fallback: ModelFallback, wanted: string | undefined): string {
  const why = fallback.category === undefined ? '' : ` (${fallback.category})`;
  return `MODEL ${name} now runs model ${fallback.to}, not ${fallback.from}: Claude Code switched after its safeguards stopped a reply${why} and keeps it for this session; type /model ${wanted ?? fallback.from} to switch back`;
}
