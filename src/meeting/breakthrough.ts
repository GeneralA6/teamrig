import type { Files } from '../core/files.ts';

/**
 * A break-through (T2524): a CRITICAL message the meeting hold let through to the lead. The cold-send hook records the
 * last one in the team's state; the spotlight script reads it every 2 s and lifts its dimming for
 * `meeting.spotlight.breakthroughSeconds` after `atMs`, so the owner sees the message at once, then dims again. Only
 * the last one counts, so the file is rewritten, never appended to.
 */
export interface Breakthrough {
  /** The start of the meeting it broke through, so a break-through in an earlier meeting lifts no later one. */
  readonly startedAt: string;
  /** When it went through, in ms since the epoch: Windows PowerShell 5.1 reads a number the same in every culture. */
  readonly atMs: number;
  /** The sending session, null when the hook could not tell which team session sent it. */
  readonly from: string | null;
}

/** The break-through file's text: one JSON object and a newline. */
export function formatBreakthrough(breakthrough: Breakthrough): string {
  return `${JSON.stringify(breakthrough)}\n`;
}

/** Records `breakthrough` as the last one, replacing any earlier. */
export async function recordBreakthrough(files: Files, path: string, breakthrough: Breakthrough): Promise<void> {
  await files.write(path, formatBreakthrough(breakthrough));
}
