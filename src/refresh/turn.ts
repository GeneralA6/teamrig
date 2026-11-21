import type { TranscriptReader } from '../ports/host/index.ts';

/** Enough of the transcript to hold its last few entries, a large tool result among them. */
export const TURN_TAIL_BYTES = 256 * 1024;

/** How the input the host records starts when the person stopped a turn by hand. */
const INTERRUPTED = '[Request interrupted by user';

/** The entries that say whether a turn runs; every other line is passed over. */
const TURN_KINDS = ['input', 'reply', 'turn-end'] as const;

/**
 * Whether the transcript's last turn is still running: a model reply, a tool result or a prompt
 * comes after the last turn end. A long foreground command or helper writes nothing for minutes, so
 * an unchanged transcript alone does not show the session is idle. A turn a notification started
 * fires no prompt hook either. A tail with no turn entry at all reads as idle.
 */
export function turnRunning(reader: TranscriptReader, tail: string): boolean {
  const lines = tail.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = reader.entry(lines[index] ?? '', TURN_KINDS);
    if (entry?.kind === 'turn-end') {
      return false;
    }
    if (entry?.kind === 'reply') {
      return true;
    }
    if (entry?.kind === 'input') {
      return (entry.text ?? entry.parts[0])?.startsWith(INTERRUPTED) !== true;
    }
  }
  return false;
}
