/**
 * The words of a start note's first line that make the note a work block's start (T1529): the live-task note says them
 * after `START <id>, <time>: ` (hooks/live-tasks.ts blockStartLines), and the meter reads a SessionStart note holding
 * that line as the block's `teamrig start` (budget/line.ts), so the rule-4 miss count never counts the `start` the
 * note tells the session to skip.
 */
export const BLOCK_START_WORDS = "this note is your work block's start";

/** Whether `line` is a start note's work-block start line: `START <id>, <time>: this note is your work block's start, ...`. */
export function isBlockStartLine(line: string): boolean {
  return line.startsWith('START ') && line.includes(`: ${BLOCK_START_WORDS}`);
}
