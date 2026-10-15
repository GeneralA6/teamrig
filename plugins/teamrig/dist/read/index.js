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
export { ACTIVE_STATUSES, isTaskStatus, priorityText, SESSION_NAME, TASK_STATUSES } from "../register/model.js";
export { readEvents, readRegister, snapshotOf } from "../register/snapshot.js";
export { byPlanOrder, dueTime } from "../register/views.js";
// The inboxes (`inbox/<area>.md`) and their read marks (`inbox-marks.jsonl`).
export { indexMarks, MARK_VERSION, parseMark, readMarks } from "../inbox/marks.js";
export { inboxLines, unreadOf } from "../inbox/unread.js";
// The kit config (`config.json`). DEFAULT_REGISTER is what a config that sets no `register` key gets,
// its priority names among them: a reader with no config to read names priorities from it.
export { DEFAULT_REGISTER } from "../config/defaults.js";
export { priorityName } from "../config/priorities.js";
export { parseConfigText } from "../config/text.js";
export { CONFIG_VERSION } from "../config/types.js";
// Session names: the config's roster with the rename log (`renames.jsonl`), so a reader finds a session
// by its id, its name or a name it had before, as every teamrig command does.
export { Roster } from "../config/roster.js";
export { readRenames, RENAME_VERSION } from "../names/rename.js";
