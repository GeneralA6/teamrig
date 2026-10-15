/**
 * The read side of teamrig's files, for readers that cannot run teamrig itself (a status pane, a
 * dashboard): the same parse, fold and counts every teamrig command uses, with nothing that touches
 * the disk, the clock or `node:` modules. A reader hands in the text it read and gets back what
 * teamrig would show. It only re-exports: the logic lives beside the commands that use it, so the
 * two can never drift. `read/index.test.ts` fails if anything reachable from here imports `node:`.
 */
// The task register (`events.jsonl`).
export { EVENT_VERSION } from "../register/events.js";
export { foldEvents, taskNumber } from "../register/fold.js";
export { ACTIVE_STATUSES, isTaskStatus, priorityText, TASK_STATUSES } from "../register/model.js";
export { readEvents, readRegister, snapshotOf } from "../register/snapshot.js";
export { byPlanOrder, dueTime } from "../register/views.js";
// The inboxes (`inbox/<area>.md`) and their read marks (`inbox-marks.jsonl`).
export { indexMarks, MARK_VERSION, parseMark, readMarks } from "../inbox/marks.js";
export { inboxLines, unreadOf } from "../inbox/unread.js";
// The kit config (`config.json`).
export { priorityName } from "../config/priorities.js";
export { parseConfigText } from "../config/text.js";
export { CONFIG_VERSION } from "../config/types.js";
