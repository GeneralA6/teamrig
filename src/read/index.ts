/**
 * The read side of teamrig's files, for readers that cannot run teamrig itself (a status pane, a
 * dashboard): the same parse, fold and counts every teamrig command uses, with nothing that touches
 * the disk, the clock or `node:` modules. A reader hands in the text it read and gets back what
 * teamrig would show. It only re-exports: the logic lives beside the commands that use it, so the
 * two can never drift. `read/index.test.ts` fails if anything reachable from here imports `node:`.
 */

// The task register (`events.jsonl`).
export { EVENT_VERSION, type CreateEvent, type RegisterEvent, type StatusEvent, type TaskFields, type UpdateEvent } from '../register/events.ts';
export { foldEvents, taskNumber, type RegisterState, type Task } from '../register/fold.ts';
export { ACTIVE_STATUSES, isTaskStatus, priorityText, TASK_STATUSES, type TaskStatus } from '../register/model.ts';
export { readEvents, readRegister, snapshotOf, type EventLogRead, type RegisterSnapshot } from '../register/snapshot.ts';
export { byPlanOrder, dueTime } from '../register/views.ts';

// The inboxes (`inbox/<area>.md`) and their read marks (`inbox-marks.jsonl`).
export { indexMarks, MARK_VERSION, parseMark, readMarks, type InboxMark, type MarkIndex, type MarkLogRead } from '../inbox/marks.ts';
export { inboxLines, unreadOf, type LineHash, type ResumeKind, type Unread } from '../inbox/unread.ts';

// The kit config (`config.json`).
export { priorityName } from '../config/priorities.ts';
export { parseConfigText, type ConfigRead } from '../config/text.ts';
export { CONFIG_VERSION, type KitConfig, type PriorityConfig } from '../config/types.ts';
