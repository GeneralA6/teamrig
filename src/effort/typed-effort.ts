import { isEffortLevel, type EffortLevel } from '../config/types.ts';
import { instantField, isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';

/** A `/effort` the user typed in the session, as its transcript keeps it. */
export interface TypedEffort {
  /** The command entry's own uuid, so a write-back can say which entry it applied. */
  readonly uuid: string;
  /** When it was typed, in epoch milliseconds. */
  readonly at: number;
  /** The level Claude Code set, from its reply: `/effort` with no level opens a picker, whose pick only the reply names. */
  readonly level: EffortLevel;
}

const COMMAND_MARK = '<command-name>/effort</command-name>';
const REPLY_MARK = '<local-command-stdout>Set effort level to ';
const REPLY_LEVEL = /^<local-command-stdout>Set effort level to ([a-z]+)\b/;

function parsedLine(line: string): JsonRecord | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    // A tail read can start mid-line: that line is no entry.
    return undefined;
  }
}

/**
 * The text of a user entry the user typed in this session's main thread, else undefined: a helper's (sidechain), a
 * meta line (a peer's message), one with an `origin` (a plugin's injected /clear, a peer), another session's, and a
 * tool result (whose content is an array) are no typing of the user's.
 */
function typedTextOf(entry: JsonRecord, claudeSession: string): string | undefined {
  if (entry['type'] !== 'user' || entry['isSidechain'] !== false || entry['isMeta'] === true || entry['origin'] !== undefined) {
    return undefined;
  }
  if (stringField(entry, 'sessionId') !== claudeSession) {
    return undefined;
  }
  const message = recordField(entry, 'message');
  return message === undefined ? undefined : stringField(message, 'content');
}

interface Command {
  readonly uuid: string;
  readonly at: number;
}

/**
 * Each `/effort` the user typed in the transcript text (whole or a tail), oldest first, with the level Claude Code
 * says it set. Only lines that hold one of the two marks are parsed. A command with no reply, or a reply naming no
 * level teamrig knows (a cancelled picker, `auto`), is left out: nothing says what level runs after it.
 */
export function typedEffortsOf(text: string, claudeSession: string): readonly TypedEffort[] {
  const commands: Command[] = [];
  const replies = new Map<string, EffortLevel>();
  for (const line of text.split('\n')) {
    if (!line.includes(COMMAND_MARK) && !line.includes(REPLY_MARK)) {
      continue;
    }
    const entry = parsedLine(line);
    const content = entry === undefined ? undefined : typedTextOf(entry, claudeSession);
    if (entry === undefined || content === undefined) {
      continue;
    }
    const uuid = stringField(entry, 'uuid');
    const at = instantField(entry, 'timestamp');
    if (content.startsWith(COMMAND_MARK) && uuid !== undefined && at !== undefined) {
      commands.push({ uuid, at });
      continue;
    }
    const parent = stringField(entry, 'parentUuid');
    const level = REPLY_LEVEL.exec(content)?.[1];
    if (parent !== undefined && isEffortLevel(level)) {
      replies.set(parent, level);
    }
  }
  return commands.flatMap(({ uuid, at }) => {
    const level = replies.get(uuid);
    return level === undefined ? [] : [{ uuid, at, level }];
  });
}
