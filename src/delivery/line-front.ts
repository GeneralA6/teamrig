import { isRecord } from '../core/guards.ts';
import { TASK_ID } from '../register/model.ts';

/**
 * The one task whose queued steps go first in the host lock's line (T4082): a blocker's fix, put there by the team's
 * lead with `teamrig pipeline front <task>`, so it no longer waits behind every step that queued before it. One at a
 * time: a new front replaces the last. `at` is when it was put there, which orders two teams' fronts in the host-wide
 * line; `by` is the lead who put it. This file holds no file access: the read entry (src/read) reaches it through
 * process-request.ts and runs without Node built-ins; the store is line-front-store.ts.
 */
export interface LineFront {
  readonly task: string;
  readonly at: string;
  readonly by: string;
}

/** The team's front file, in its state folder: each team's lead fronts only its own team's tasks. */
export const LINE_FRONT_FILE = 'line-front.json';

/** A front as its file stores it; a field another kit adds is ignored. */
export function isLineFront(value: unknown): value is LineFront {
  if (!isRecord(value)) {
    return false;
  }
  const { task, at, by } = value;
  return typeof task === 'string' && TASK_ID.test(task) && typeof at === 'string' && !Number.isNaN(Date.parse(at)) && typeof by === 'string';
}
