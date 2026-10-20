/**
 * The read side of teamrig's files, for readers that cannot run teamrig itself (a status pane, a
 * dashboard): the same parse, fold and counts every teamrig command uses, with nothing that touches
 * the disk, the clock or `node:` modules. A reader hands in the text it read and gets back what
 * teamrig would show. It only re-exports: the logic lives beside the commands that use it, so the
 * two can never drift. `read/index.test.ts` fails if anything reachable from here imports `node:`.
 */

// The task register (`events.jsonl`, and once rotated its `archive/` and `snapshot.jsonl`).
export { EVENT_VERSION, type CreateEvent, type RegisterEvent, type StatusEvent, type TaskFields, type UpdateEvent } from '../register/events.ts';
export { foldEvents, taskNumber, type RegisterState, type Task } from '../register/fold.ts';
export { ACTIVE_STATUSES, isTaskStatus, priorityText, SESSION_NAME, TASK_STATUSES, type TaskStatus } from '../register/model.ts';
export {
  assemble,
  historyPlan,
  layoutPaths,
  MissingSegmentError,
  readHistory,
  readSnapshotText,
  readWorkingSet,
  segmentName,
  workingSetPlan,
  ARCHIVE_DIR,
  SNAPSHOT_FILE,
  type LayoutFiles,
  type LayoutPaths,
  type ReadPlan,
  type SnapshotHeader,
  type SnapshotRead,
} from '../register/layout.ts';
export { LAYOUT_VERSION } from '../register/marker.ts';
export { readEvents, readRegister, snapshotOf, type EventLogRead, type RegisterSnapshot, type RetiredTasks } from '../register/snapshot.ts';
export { loopFix, needPath, needsOf, pathText, planOrder, TaskTree, type EffectiveDue, type NextMove, type PlanPlace, type TreeTask, type WaitingOnYou } from '../register/tree.ts';
export { byPlanOrder, dueTime, type PlanOrdered } from '../register/views.ts';

// Time: the team's zone (`config.timeZone`, else the machine's). A stored bare day is a day of it, a stored minute is
// UTC, and every time prints in it, zone-marked (`01-31 11:05 IST`); a reader passes it to the calls that print one.
export { showStored, storedText } from '../core/time.ts';
export { TimeZone } from '../core/zone.ts';
export {
  allReady,
  isReady,
  unfinishedAfter,
  WAIT_KINDS,
  waitContext,
  waitsText,
  waitText,
  type WaitContext,
  type WaitKind,
  type WaitReason,
} from '../register/waits.ts';

// The inboxes (`inbox/<area>.md`) and their read marks (`inbox-marks.jsonl`).
export { indexMarks, MARK_VERSION, parseMark, readMarks, type InboxMark, type MarkIndex, type MarkLogRead } from '../inbox/marks.ts';
export { inboxLines, unreadOf, type LineHash, type ResumeKind, type Unread } from '../inbox/unread.ts';

// The kit config (`config.json`). DEFAULT_REGISTER is what a config that sets no `register` key gets,
// its priority names among them: a reader with no config to read names priorities from it.
export { DEFAULT_REGISTER } from '../config/defaults.ts';
export { priorityName } from '../config/priorities.ts';
export { parseConfigText, type ConfigRead } from '../config/text.ts';
export { CONFIG_VERSION, type KitConfig, type PriorityConfig } from '../config/types.ts';

// Session names: the config's roster with the rename log (`renames.jsonl`), so a reader finds a session
// by its id, its name or a name it had before, as every teamrig command does.
export { Roster, type SessionLookup } from '../config/roster.ts';
export { readRenames, RENAME_VERSION, type Rename, type RenameLogRead } from '../names/rename.ts';

// The lead tree: `roles.lead` over the sub-leads the config's `leads` names, so a reader shows a session's leader
// and a leader's group as teamrig's approvals and lists find them.
export { LeadTree } from '../config/lead-tree.ts';

// Each session's turn log (`turn-log/<session id>/<UTC hour>.jsonl`): its prompts, replies and clears, one parsed
// JSON line at a time.
export { parseEntry, TURN_LOG_VERSION, type TurnLogEntry, type TurnLogKind } from '../turn-log/entry.ts';
