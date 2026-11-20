import type { TranscriptReader } from '../ports/host/index.ts';

/**
 * Where a session's transcript says it runs now, for the restore after a reboot. The host marks each turn's entries
 * with where they ran, a background job's (a daemon job, a session sent to the background) as a job's, though the
 * job's hooks may not see that in their environment. A session carried on in another, as a tab's is when it goes to
 * a background job, gets one `continued` entry naming that session.
 */
export interface TranscriptKind {
  /** Its last turn ran as a background job, which the daemon resumes itself. */
  readonly background: boolean;
  /** The session it was continued in after its last turn; undefined when none, or when it had a turn since. */
  readonly continuedIn: string | undefined;
}

/**
 * How much of a transcript's end is read for its kind: its last turn's entries and any `continued` one after them
 * sit there, short of one tool result larger than this, which leaves the session judged as before.
 */
export const KIND_TAIL_BYTES = 1024 * 1024;

/**
 * The transcript's kind, read from its end through the host's `reader`: the last entry that says where it ran is the
 * last turn's, and only the few lines after it (titles, modes, snapshots) are read on the way. A torn first line of
 * a tail is unread and skipped.
 */
export function transcriptKindOf(reader: TranscriptReader, text: string): TranscriptKind {
  const lines = text.split('\n');
  let continuedIn: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = reader.entry(lines[index] ?? '');
    if (entry === undefined || entry.kind === 'unread') {
      continue;
    }
    if (entry.kind === 'continued') {
      continuedIn ??= entry.into;
      continue;
    }
    if (entry.job !== undefined) {
      return { background: entry.job, continuedIn };
    }
  }
  return { background: false, continuedIn };
}
