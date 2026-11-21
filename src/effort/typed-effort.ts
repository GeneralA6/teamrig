import { isEffortLevel, type EffortLevel } from '../config/types.ts';
import type { TranscriptReader } from '../ports/host/index.ts';

/** A `/effort` the user typed in the session, as its transcript keeps it. */
export interface TypedEffort {
  /** The command entry's own id, so a write-back can say which entry it applied. */
  readonly uuid: string;
  /** When it was typed, in epoch milliseconds. */
  readonly at: number;
  /** The level the host set, from its reply: `/effort` with no level opens a picker, whose pick only the reply names. */
  readonly level: EffortLevel;
}

const COMMAND_MARK = '<command-name>/effort</command-name>';
const REPLY_MARK = '<local-command-stdout>Set effort level to ';
const REPLY_LEVEL = /^<local-command-stdout>Set effort level to ([a-z]+)\b/;

interface Typed {
  readonly text: string;
  readonly id: string | undefined;
  readonly at: number | undefined;
  readonly parent: string | undefined;
}

/**
 * The line as text the user typed in this session's main thread, else undefined: a helper's, the host's own text
 * (a peer's message), one that names where it came from (a plugin's injected /clear, a peer), another session's,
 * and a tool result (whose content is a list of parts) are no typing of the user's. So is a torn line of a tail
 * read, which starts mid-line.
 */
function typedOf(reader: TranscriptReader, line: string, hostSession: string): Typed | undefined {
  const entry = reader.entry(line, ['input']);
  if (entry?.kind !== 'input' || entry.thread !== 'main' || entry.meta || entry.origin !== undefined || entry.session !== hostSession) {
    return undefined;
  }
  return entry.text === undefined ? undefined : { text: entry.text, id: entry.id, at: entry.at, parent: entry.parent };
}

interface Command {
  readonly uuid: string;
  readonly at: number;
}

/**
 * Each `/effort` the user typed in the transcript text (whole or a tail), oldest first, with the level the host
 * says it set. Only lines that hold one of the two marks are read. A command with no reply, or a reply naming no
 * level teamrig knows (a cancelled picker, `auto`), is left out: nothing says what level runs after it.
 */
export function typedEffortsOf(reader: TranscriptReader, text: string, hostSession: string): readonly TypedEffort[] {
  const commands: Command[] = [];
  const replies = new Map<string, EffortLevel>();
  for (const line of text.split('\n')) {
    if (!line.includes(COMMAND_MARK) && !line.includes(REPLY_MARK)) {
      continue;
    }
    const typed = typedOf(reader, line, hostSession);
    if (typed === undefined) {
      continue;
    }
    if (typed.text.startsWith(COMMAND_MARK) && typed.id !== undefined && typed.at !== undefined) {
      commands.push({ uuid: typed.id, at: typed.at });
      continue;
    }
    const level = REPLY_LEVEL.exec(typed.text)?.[1];
    if (typed.parent !== undefined && isEffortLevel(level)) {
      replies.set(typed.parent, level);
    }
  }
  return commands.flatMap(({ uuid, at }) => {
    const level = replies.get(uuid);
    return level === undefined ? [] : [{ uuid, at, level }];
  });
}
