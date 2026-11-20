import { stringField } from '../core/guards.ts';
import type { EntryKind, InputEntry, InputOrigin, ReplyEntry, TranscriptReader } from '../ports/host/index.ts';

/**
 * What the owner (the person at the tab) typed in the session a refresh replaces. The handover is the old
 * session's own summary: a decision the owner gave after it was written, or one it never copied over, was lost with
 * the /clear. The fresh start writes the owner's prompts from the old transcript, newest kept, to a file beside the
 * handover and its note points at it, so nothing the owner said is lost; those after the last write of the handover
 * are marked as ones it cannot hold. A file, not the note: the start's whole context is capped (CONTEXT_MAX_CHARS).
 */
export interface OwnerTurn {
  readonly text: string;
  /** Typed after the last write of the handover the session made, so the handover cannot hold it. */
  readonly afterHandover: boolean;
}

/** The most the carried prompts may take, newest kept, under a handover's own cap; one prompt longer than the room left is cut. */
export const OWNER_TURNS_MAX_CHARS = 16_000;
/** The most prompts carried, newest kept. */
export const OWNER_TURNS_MAX = 40;
/** A prompt typed this many times or more, word for word, is a scheduled or pasted check, not something the owner said. */
const REPEATED_AT = 3;

/** Prompts teamrig types into a session themselves: never the owner's. */
const MACHINE_PREFIXES: readonly string[] = ['<', '/', 'You were started fresh after your context refresh', 'New work was handed to you while this tab was idle'];
/** Tools whose call writes a file by its `file_path`. */
const FILE_WRITERS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Tools whose call schedules its `prompt` to be typed later. */
const SCHEDULERS: ReadonlySet<string> = new Set(['CronCreate', 'ScheduleWakeup']);
/** Where the host says a turn nobody typed came from. */
const MACHINE_ORIGINS: ReadonlySet<InputOrigin> = new Set<InputOrigin>(['scheduled', 'notification', 'peer', 'handback']);
/** The entries that can matter; the reader passes over the rest of a large transcript unparsed. */
const KINDS: readonly EntryKind[] = ['input', 'reply', 'scheduled-carry'];

/** An input's typed text: its plain text, else its text parts joined; undefined for a tool's results or none. */
function typedTextOf(input: InputEntry): string | undefined {
  if (input.text !== undefined) {
    return input.text;
  }
  return input.results.length > 0 || input.parts.length === 0 ? undefined : input.parts.join('\n');
}

/** The host marks this input as a turn nobody typed: meta, a compaction's summary, a helper's, a tool's answer, scheduled, a notification or a peer's. */
function machineInput(input: InputEntry): boolean {
  if (input.meta || input.continuation || input.thread === 'helper' || input.fromTool) {
    return true;
  }
  return (input.origin !== undefined && MACHINE_ORIGINS.has(input.origin)) || (input.turnOrigin !== undefined && MACHINE_ORIGINS.has(input.turnOrigin));
}

/** What the owner typed in this input; undefined for a turn nobody typed, an empty one, or a prompt teamrig types itself. */
function ownerPromptOf(input: InputEntry): string | undefined {
  const prompt = machineInput(input) ? undefined : typedTextOf(input)?.trim();
  return prompt === undefined || prompt === '' || MACHINE_PREFIXES.some((prefix) => prompt.startsWith(prefix)) ? undefined : prompt;
}

/** Whether a reply's tool call writes `handoverPath`: a file tool on it, or a shell command that names it. */
function writesHandover(reply: ReplyEntry, handoverPath: string): boolean {
  return reply.calls.some(({ name, input }) => {
    if (input === undefined) {
      return false;
    }
    if (FILE_WRITERS.has(name)) {
      return stringField(input, 'file_path') === handoverPath || stringField(input, 'notebook_path') === handoverPath;
    }
    return name === 'Bash' && (stringField(input, 'command') ?? '').includes(handoverPath);
  });
}

/** The prompts a reply's tool calls schedule: their firing is no owner's. */
function scheduledPromptsOf(reply: ReplyEntry): readonly string[] {
  return reply.calls.flatMap(({ name, input }) => (input !== undefined && SCHEDULERS.has(name) ? (stringField(input, 'prompt') ?? []) : []));
}

/** A prompt as carried: within the cap, cut with a mark when longer. */
function clipped(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * The owner's prompts in an old transcript, oldest first, newest kept within `OWNER_TURNS_MAX` and
 * `OWNER_TURNS_MAX_CHARS`: the inputs that are typed text, less those the host marks as nobody's (meta, a
 * compaction's summary, a helper's, scheduled, a notification, a peer's), the prompts teamrig types
 * itself, the firing of a job this transcript scheduled (by a tool call, or listed live at a compaction) or the
 * session `scheduled` before, and any prompt repeated word for word `REPEATED_AT` times or more. A prompt said twice
 * is carried once, at its last time. Those after the last tool call that wrote `handoverPath` are marked
 * `afterHandover`.
 */
export function ownerTurnsOf(reader: TranscriptReader, text: string, handoverPath: string, scheduled: Iterable<string> = []): readonly OwnerTurn[] {
  const skip = new Set([...scheduled].map((prompt) => prompt.trim()));
  const typed: { readonly text: string; readonly index: number }[] = [];
  let lastWrite = -1;
  for (const line of text.split('\n')) {
    const entry = reader.entry(line, KINDS);
    if (entry?.kind === 'scheduled-carry') {
      entry.jobs.forEach((job) => skip.add(job.prompt.trim()));
    } else if (entry?.kind === 'reply') {
      scheduledPromptsOf(entry).forEach((prompt) => skip.add(prompt.trim()));
      if (writesHandover(entry, handoverPath)) {
        lastWrite = typed.length;
      }
    } else if (entry?.kind === 'input') {
      const prompt = ownerPromptOf(entry);
      if (prompt !== undefined) {
        typed.push({ text: prompt, index: typed.length });
      }
    }
  }
  const counts = new Map<string, number>();
  for (const turn of typed) {
    counts.set(turn.text, (counts.get(turn.text) ?? 0) + 1);
  }
  const kept: OwnerTurn[] = [];
  const seen = new Set<string>();
  let room = OWNER_TURNS_MAX_CHARS;
  for (const turn of [...typed].reverse()) {
    if (kept.length >= OWNER_TURNS_MAX || room <= 0) {
      break;
    }
    if (skip.has(turn.text) || (counts.get(turn.text) ?? 0) >= REPEATED_AT || seen.has(turn.text)) {
      continue;
    }
    seen.add(turn.text);
    const carried = clipped(turn.text, room);
    room -= carried.length;
    kept.push({ text: carried, afterHandover: turn.index >= lastWrite && lastWrite >= 0 });
  }
  return kept.reverse();
}

/** The file of the owner's prompts the fresh start reads: each one under its own heading, oldest first. */
export function ownerTurnsText(turns: readonly OwnerTurn[]): string {
  const parts = ['# What the owner typed in your old session', '', 'Oldest first. Check each against your handover and act on any decision or ask it does not cover.', ''];
  turns.forEach((turn, index) => {
    parts.push(`## ${index + 1}${turn.afterHandover ? ' (after your handover was written: it does not hold this)' : ''}`, '', turn.text, '');
  });
  return parts.join('\n');
}

/** The note's line that points the fresh start at that file; undefined for no prompts. */
export function ownerTurnsLine(turns: readonly OwnerTurn[], path: string): string | undefined {
  if (turns.length === 0) {
    return undefined;
  }
  const after = turns.filter((turn) => turn.afterHandover).length;
  const late = after === 0 ? '' : `, ${after} of them after your handover was written`;
  return `The owner typed ${turns.length} prompt(s) in your old session${late}: read ${path} after your handover and act on any decision or ask it does not cover.`;
}
