import type { Roster } from '../config/roster.ts';
import { isReservedName, NAME_PATTERN, NAME_RULE, RESERVED_RULE } from '../core/ids.ts';
import type { Clock, Mutex } from '../core/lock.ts';
import type { RenameLog } from './log.ts';
import { RENAME_VERSION, type Rename } from './rename.ts';

export interface RenameRequest {
  readonly id: string;
  readonly to: string;
  /** The session recording it: only the session itself or the lead may. */
  readonly by: string;
}

/** Every outcome carries the roster as it stands after it, so a caller can name sessions right away. */
export type RenameOutcome =
  | { readonly kind: 'recorded'; readonly rename: Rename; readonly roster: Roster }
  | { readonly kind: 'unchanged'; readonly roster: Roster }
  | { readonly kind: 'refused'; readonly reason: string; readonly roster: Roster };

export interface RenameDeps {
  readonly log: RenameLog;
  readonly mutex: Mutex;
  readonly clock: Clock;
  /** The team's roster over a rename log. */
  readonly rosterOf: (renames: readonly Rename[]) => Roster;
}

/** What a rename request comes to on a roster, before anything is written. */
export type RenameCheck =
  | { readonly kind: 'allowed'; readonly from: string }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * The team's rules for a new name: only the session itself or the lead may record it; it must be a
 * valid name, not one Claude Code reserves, not another session's id and not another session's current name. A name another
 * session had before may be taken: the newest record wins, so it stops finding that session.
 */
export function checkRename(roster: Roster, request: RenameRequest): RenameCheck {
  const { id, to, by } = request;
  const from = roster.nameOf(id);
  if (from === undefined) {
    return { kind: 'refused', reason: `${id} is not a session on this team (sessions: ${roster.describe()})` };
  }
  if (by !== id && by !== roster.holderOf('lead')) {
    return { kind: 'refused', reason: `only ${id} itself or the lead may record its new name` };
  }
  if (from === to) {
    return { kind: 'unchanged' };
  }
  if (!NAME_PATTERN.test(to)) {
    return { kind: 'refused', reason: `"${to}" cannot be a session name: ${NAME_RULE}` };
  }
  if (isReservedName(to)) {
    return { kind: 'refused', reason: `${to} ${RESERVED_RULE}: give the tab another name with /rename` };
  }
  if (to !== id && roster.ids.includes(to)) {
    return { kind: 'refused', reason: `${to} is the id of another session` };
  }
  const holders = roster.idsCalled(to);
  return holders.length === 0 ? { kind: 'allowed', from } : { kind: 'refused', reason: `${to} is already the name of ${holders.join(', ')}` };
}

/**
 * Records that a session is now called `to`, as one append under the log's lock: the log is read,
 * checked and written inside it, so two recorders never both take one name. Nothing is moved or
 * rewritten; the old names keep finding the session. Refused beside records from a newer release.
 */
export function recordRename(deps: RenameDeps, request: RenameRequest): Promise<RenameOutcome> {
  const { id, to, by } = request;
  return deps.mutex.run(async () => {
    const read = await deps.log.read();
    const roster = deps.rosterOf(read.renames);
    const check = checkRename(roster, request);
    if (check.kind === 'unchanged') {
      return { kind: 'unchanged', roster };
    }
    if (check.kind === 'refused') {
      return { kind: 'refused', reason: check.reason, roster };
    }
    if (read.newer > 0) {
      const reason = `${deps.log.path} holds renames from a newer teamrig; update teamrig before recording one`;
      return { kind: 'refused', reason, roster };
    }
    const rename: Rename = { v: RENAME_VERSION, id, from: check.from, to, at: new Date(deps.clock.now()).toISOString(), by };
    await deps.log.append(rename);
    return { kind: 'recorded', rename, roster: deps.rosterOf([...read.renames, rename]) };
  });
}
