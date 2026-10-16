import { stringField, type JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';

/** Enough of the transcript to hold its last few entries, a large tool result among them. */
export const TURN_TAIL_BYTES = 256 * 1024;

/**
 * The `system` entries Claude Code writes once nothing more is coming: `stop_hook_summary` and
 * `turn_duration` after the model stopped, `local_command` after a slash command that started no turn.
 */
const TURN_ENDS: ReadonlySet<string> = new Set(['stop_hook_summary', 'turn_duration', 'local_command']);
/** What Claude Code records as the user's entry when the user stops a turn with Escape. */
const INTERRUPTED = '[Request interrupted by user';

/** The text of a `user` entry: its string content, or its first text block. */
function userTextOf(entry: JsonRecord): string | undefined {
  const message = entry['message'];
  if (typeof message !== 'object' || message === null || !('content' in message)) {
    return undefined;
  }
  const { content } = message;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string') {
      return block.text;
    }
  }
  return undefined;
}

/**
 * Whether the transcript's last turn is still running: a model reply, a tool result or a prompt
 * comes after the last turn end. A long foreground command or helper writes nothing for minutes, so
 * an unchanged transcript alone does not show the session is idle. A turn a notification started
 * fires no prompt hook either. A tail with no turn entry at all reads as idle.
 */
export function turnRunning(tail: string): boolean {
  const lines = tail.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = parseObject(lines[index]?.trim() ?? '');
    if (entry === undefined) {
      continue;
    }
    switch (entry['type']) {
      case 'system': {
        const subtype = stringField(entry, 'subtype');
        if (subtype !== undefined && TURN_ENDS.has(subtype)) {
          return false;
        }
        break;
      }
      case 'assistant':
        return true;
      case 'user':
        return userTextOf(entry)?.startsWith(INTERRUPTED) !== true;
      default:
        break;
    }
  }
  return false;
}
