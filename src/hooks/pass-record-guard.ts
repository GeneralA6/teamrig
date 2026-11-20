import type { HookEvent, HookReply } from '../ports/host/index.ts';
import { PASS_RECORD_FOLDER } from '../push-guard/pass-record.ts';
import { refusal } from './permission.ts';

/**
 * The pass-record guard: a tree's pass record (src/push-guard/pass-record.ts) lets a push or a merge skip the checks
 * that tree already passed, so only the repo's local runner may write one. The guard refuses a session's own write of
 * one: a file-writing call naming a path in the records' folder, and a shell line naming the folder at all (the line's
 * reads too, since a shell line's writes cannot be told from its reads; the tools that only read or search stay open).
 * It reads only the call: a script the line starts, or a path built when it runs, still reaches the folder, since
 * sessions and the runner share one account (stopgap T791: phase 2 runs the runner on an account of its own).
 */

/** A path with the records' folder as one of its folders, either slash, any case. */
const IN_RECORD_FOLDER = new RegExp(`(^|[\\\\/])${PASS_RECORD_FOLDER}[\\\\/]`, 'i');

/** The folder's name as a word of its own: `.git/local-ci/x.json`, `'local-ci'`, not `my-local-ci`. */
const NAMES_RECORD_FOLDER = new RegExp(`(?<![\\w-])${PASS_RECORD_FOLDER}(?![\\w-])`, 'i');

/** What in the call reaches the pass records, for the reason; undefined when nothing does. */
export function passRecordReach(event: HookEvent): string | undefined {
  const { call } = event;
  if (call?.kind === 'edit') {
    const { path } = call;
    return path !== undefined && IN_RECORD_FOLDER.test(path) ? `this ${call.name} writes ${path}, in the folder of the trees' pass records` : undefined;
  }
  if (call?.kind === 'shell') {
    const line = call.command;
    return line !== undefined && NAMES_RECORD_FOLDER.test(line) ? `this ${call.name} line names ${PASS_RECORD_FOLDER}, the folder of the trees' pass records` : undefined;
  }
  return undefined;
}

/** Why the call is refused, with what to do instead. */
export function passRecordReason(reach: string): string {
  return (
    `teamrig pass-record guard: ${reach}. Only the repo's local runner writes a record, after every check passed on ` +
    'the tree (its pre-push hook, `ship.ts check`); one a session writes, moves or deletes would let a push or a merge ' +
    "skip the tree's tests. Run the repo's local checks instead; read a record with the Read tool and search code with " +
    'the Grep tool. Do not retry this or route around it: a record that looks wrong goes to the lead.'
  );
}

/** The reply to a file write or a shell call about to run: a refusal when it reaches the pass records, else none. */
export function passRecordGuardReply(event: HookEvent): HookReply | undefined {
  const reach = passRecordReach(event);
  return reach === undefined ? undefined : refusal(passRecordReason(reach));
}
