import { stringField } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';

/**
 * Where a session's transcript says it runs now, for the restore after a reboot. Claude Code stamps each turn's
 * records with their `entrypoint`, and a background job's (a daemon job, a session sent to the background) with
 * `sessionKind: "bg"` too, though the job's hooks may not see `$CLAUDE_CODE_SESSION_KIND`. A session carried on in
 * another, as a tab's is when it goes to a background job, gets one `continued-in` record naming that session.
 */
export interface TranscriptKind {
  /** Its last turn ran as a background job, which the daemon resumes itself. */
  readonly background: boolean;
  /** The session it was continued in after its last turn; undefined when none, or when it had a turn since. */
  readonly continuedIn: string | undefined;
}

/**
 * How much of a transcript's end is read for its kind: its last turn's records and any `continued-in` after them sit
 * there, short of one tool result larger than this, which leaves the session judged as before.
 */
export const KIND_TAIL_BYTES = 1024 * 1024;

const CONTINUED_IN = 'continued-in';
const ENTRYPOINT = '"entrypoint"';

/** The transcript's kind, read from its end; a torn first line of a tail fails to parse and is skipped. */
export function transcriptKindOf(text: string): TranscriptKind {
  const lines = text.split('\n');
  let continuedIn: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    // Most records at a transcript's end (titles, modes, snapshots) name neither; only these two are parsed.
    const record = line.includes(ENTRYPOINT) || line.includes(CONTINUED_IN) ? parseObject(line) : undefined;
    if (record === undefined) {
      continue;
    }
    if (record['type'] === CONTINUED_IN) {
      continuedIn ??= stringField(record, 'continuedInSessionId');
      continue;
    }
    if (stringField(record, 'entrypoint') !== undefined) {
      return { background: stringField(record, 'sessionKind') === 'bg', continuedIn };
    }
  }
  return { background: false, continuedIn };
}
