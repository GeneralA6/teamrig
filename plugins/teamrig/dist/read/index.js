/**
 * The read side of teamrig's files, for readers that cannot run teamrig itself (a status pane, a
 * dashboard): the same parse, fold and counts every teamrig command uses, with nothing that touches
 * the disk, the clock or `node:` modules. A reader hands in the text it read and gets back what
 * teamrig would show. It only re-exports: the logic lives beside the commands that use it, so the
 * two can never drift. `read/index.test.ts` fails if anything reachable from here imports `node:`.
 */
// The task register (`events.jsonl`, and once rotated its `archive/` and `snapshot.jsonl`).
export { EVENT_VERSION, TASK_LINE_VERSION } from "../register/events.js";
export { foldEvents, taskNumber } from "../register/fold.js";
export { ACTIVE_STATUSES, isTaskStatus, priorityText, SESSION_NAME, TASK_STATUSES } from "../register/model.js";
export { assemble, historyPlan, layoutPaths, MissingSegmentError, readHistory, readSnapshotText, readWorkingSet, segmentName, workingSetPlan, ARCHIVE_DIR, SNAPSHOT_FILE, } from "../register/layout.js";
export { LAYOUT_VERSION } from "../register/marker.js";
export { readEvents, readRegister, snapshotOf } from "../register/snapshot.js";
export { loopFix, needPath, needsOf, pathText, planOrder, TaskTree } from "../register/tree.js";
export { byPlanOrder, dueTime } from "../register/views.js";
// The done groups (T1729): one rule that sorts a span's done work for the daily report, the agenda and the Done page.
export { DONE_GROUP_KINDS, doneGroups, doneGroupTitle, URGENT_PRIORITY } from "../register/done-groups.js";
// Time: the team's zone (`config.timeZone`, else the machine's). A stored bare day is a day of it, a stored minute is
// UTC, and every time prints in it, zone-marked (`01-31 11:05 IST`); a reader passes it to the calls that print one.
export { showStored, storedText } from "../core/time.js";
export { TimeZone } from "../core/zone.js";
export { allReady, isReady, unfinishedAfter, WAIT_KINDS, waitContext, waitsText, waitText, } from "../register/waits.js";
// Waits on the owner: which tasks wait on the owner's decision or approval, which of those the lead asks now and which
// the owner put off (Later) until a time, and each session's cards grouped as `teamrig meet` asks them (T1295). The
// owner marker is the config's `register.ownerSource`, `requireGate` its `register.requireDecisionCard`.
export { asksOwner, deferredUntil, isUngated, ownerCardsBySession, ownerLater, waitsOnOwner, } from "../register/owner-waits.js";
// The register's numbers over time (T1771): each day's flow, new work by source, lead and cycle times, due-date hits,
// waits, bugs and done per session for a team tree and a range, and the Health tiles over them with their levels, as
// `teamrig stats` prints them. The owner marker is the config's `register.ownerSource`.
export { isActive, isStatsRange, RECENT_DAYS, registerStats, STATS_ACTIVE_STATUSES, STATS_RANGES, WORK_SOURCES, } from "../register/stats.js";
export { HEALTH_LEVELS, HEALTH_THRESHOLDS, registerHealth, } from "../register/stats-health.js";
// The inboxes (`inbox/<area>.md`) and their read marks (`inbox-marks.jsonl`).
export { indexMarks, MARK_VERSION, parseMark, readMarks } from "../inbox/marks.js";
export { inboxLines, unreadOf } from "../inbox/unread.js";
// The kit config (`config.json`). DEFAULT_REGISTER is what a config that sets no `register` key gets,
// its priority names among them: a reader with no config to read names priorities from it.
export { DEFAULT_REGISTER } from "../config/defaults.js";
export { priorityName } from "../config/priorities.js";
export { parseConfigText } from "../config/text.js";
export { CONFIG_VERSION } from "../config/types.js";
// A session's launch settings: the model and effort it starts on (its `launch` entry, the lead's defaults under it), so
// a reader shows them as teamrig launches the session, in its words.
export { describeLaunch, launchOf } from "../config/launch.js";
// Session names: the config's roster with the rename log (`renames.jsonl`), so a reader finds a session
// by its id, its name or a name it had before, as every teamrig command does; and the form people read a
// session in, `[acme] lead`, as the tab titles show it.
export { Roster } from "../config/roster.js";
export { readRenames, RENAME_VERSION } from "../names/rename.js";
export { bareName, sessionDisplay } from "../core/ids.js";
// The lead tree: `roles.lead` over the sub-leads the config's `leads` names, so a reader shows a session's leader
// and a leader's group as teamrig's approvals and lists find them.
export { LeadTree } from "../config/lead-tree.js";
// The team tree: each team config's `team.parent` link, read across the kit home's team folders, so a reader shows a
// team's parent, children and root as teamrig's routing and `list --tree` find them.
export { TeamTree, teamNodeOf } from "../config/tree.js";
// The hire log (`hires.jsonl`): who was hired for what job and who retired, so a reader marks a team's hired and
// retired sessions as teamrig's hire and retire commands count them.
export { activeHires, HIRE_FORMAT, readHiringLog, rehiredFrom, retiredSessions, } from "../hiring/record.js";
// Each team's week (`state/usage/team.week.json` under its home, `TEAM_WEEK_PATH`): its used and planned part of the
// account's week, as its budget hooks last read it. One file per team; a reader adds a child team's to its parent's.
export { parseTeamWeek, TEAM_WEEK_FORMAT, TEAM_WEEK_PATH } from "../budget/team-week-summary.js";
// Each session's turn log (`turn-log/<session id>/<UTC hour>.jsonl`): its prompts, replies and clears, one parsed
// JSON line at a time.
export { parseEntry, TURN_LOG_VERSION } from "../turn-log/entry.js";
