import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';

/**
 * What the owner (the person at the tab) typed in the session a refresh replaces The handover is the old
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
/** Claude Code's own `turnOrigin`s and `origin.kind`s for a turn nobody typed. */
const MACHINE_ORIGINS: ReadonlySet<string> = new Set(['scheduled', 'task_notification', 'task-notification', 'peer']);

function contentOf(entry: JsonRecord): unknown {
  const message = entry['message'];
  return isRecord(message) ? message['content'] : undefined;
}

/** A user entry's typed text: its string content, else its text blocks joined; undefined for a tool result or none. */
function typedTextOf(entry: JsonRecord): string | undefined {
  const content = contentOf(entry);
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content) || content.some((block) => isRecord(block) && block['type'] === 'tool_result')) {
    return undefined;
  }
  const texts = content.filter(isRecord).flatMap((block) => (block['type'] === 'text' ? (stringField(block, 'text') ?? []) : []));
  return texts.length === 0 ? undefined : texts.join('\n');
}

/** Claude Code marks this entry as a turn nobody typed: meta, a compaction's summary, a subagent's, scheduled, a notification or a peer's. */
function machineEntry(entry: JsonRecord): boolean {
  if (entry['isMeta'] === true || entry['isCompactSummary'] === true || entry['isSidechain'] === true || entry['toolUseResult'] !== undefined) {
    return true;
  }
  const origin = entry['origin'];
  const kind = isRecord(origin) ? stringField(origin, 'kind') : undefined;
  const turnOrigin = stringField(entry, 'turnOrigin');
  return (kind !== undefined && MACHINE_ORIGINS.has(kind)) || (turnOrigin !== undefined && MACHINE_ORIGINS.has(turnOrigin));
}

/** Whether an assistant entry's tool call writes `handoverPath`: a file tool on it, or a shell command that names it. */
function writesHandover(entry: JsonRecord, handoverPath: string): boolean {
  const content = contentOf(entry);
  if (!Array.isArray(content)) {
    return false;
  }
  return content.filter(isRecord).some((block) => {
    const input = block['input'];
    if (block['type'] !== 'tool_use' || !isRecord(input)) {
      return false;
    }
    const name = stringField(block, 'name') ?? '';
    if (FILE_WRITERS.has(name)) {
      return stringField(input, 'file_path') === handoverPath || stringField(input, 'notebook_path') === handoverPath;
    }
    return name === 'Bash' && (stringField(input, 'command') ?? '').includes(handoverPath);
  });
}

/** The prompts scheduled in this transcript (CronCreate, ScheduleWakeup, a compaction's job snapshot): their firing is no owner's. */
function scheduledPromptsOf(entry: JsonRecord, into: Set<string>): void {
  const attachment = entry['attachment'];
  if (isRecord(attachment) && attachment['type'] === 'session_cron_carry') {
    for (const key of ['tasks', 'otherArmed']) {
      const tasks = attachment[key];
      for (const task of Array.isArray(tasks) ? tasks.filter(isRecord) : []) {
        const prompt = stringField(task, 'prompt');
        if (prompt !== undefined) {
          into.add(prompt.trim());
        }
      }
    }
  }
  const content = contentOf(entry);
  for (const block of Array.isArray(content) ? content.filter(isRecord) : []) {
    const input = block['input'];
    const name = stringField(block, 'name');
    if (block['type'] === 'tool_use' && isRecord(input) && (name === 'CronCreate' || name === 'ScheduleWakeup')) {
      const prompt = stringField(input, 'prompt');
      if (prompt !== undefined) {
        into.add(prompt.trim());
      }
    }
  }
}

/** A prompt as carried: within the cap, cut with a mark when longer. */
function clipped(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * The owner's prompts in an old transcript, oldest first, newest kept within `OWNER_TURNS_MAX` and
 * `OWNER_TURNS_MAX_CHARS`: the user turns that are typed text, less those Claude Code marks as nobody's (meta, a
 * compaction's summary, a subagent's, scheduled, a notification, a peer's), the prompts teamrig types
 * itself, the firing of a job this transcript scheduled or the session `scheduled` before, and any prompt repeated
 * word for word `REPEATED_AT` times or more. A prompt said twice is carried once, at its last time. Those after the
 * last tool call that wrote `handoverPath` are marked `afterHandover`.
 */
export function ownerTurnsOf(text: string, handoverPath: string, scheduled: Iterable<string> = []): readonly OwnerTurn[] {
  const skip = new Set([...scheduled].map((prompt) => prompt.trim()));
  const typed: { readonly text: string; readonly index: number }[] = [];
  let lastWrite = -1;
  for (const line of text.split('\n')) {
    const entry = line.includes('"user"') || line.includes('"assistant"') || line.includes('session_cron_carry') ? parseObject(line.trim()) : undefined;
    if (entry === undefined) {
      continue;
    }
    scheduledPromptsOf(entry, skip);
    if (entry['type'] === 'assistant' && writesHandover(entry, handoverPath)) {
      lastWrite = typed.length;
    }
    const prompt = entry['type'] === 'user' && !machineEntry(entry) ? typedTextOf(entry)?.trim() : undefined;
    if (prompt !== undefined && prompt !== '' && !MACHINE_PREFIXES.some((prefix) => prompt.startsWith(prefix))) {
      typed.push({ text: prompt, index: typed.length });
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
