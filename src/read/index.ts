/**
 * The read side of teamrig's files, for readers that cannot run teamrig itself (a status pane, a
 * dashboard): the same parse, fold and counts every teamrig command uses, with nothing that touches
 * the disk, the clock or `node:` modules. A reader hands in the text it read and gets back what
 * teamrig would show. It only re-exports: the logic lives beside the commands that use it, so the
 * two can never drift. `read/index.test.ts` fails if anything reachable from here imports `node:`.
 */

// The task register (`events.jsonl`, and once rotated its `archive/` and `snapshot.jsonl`).
export { EVENT_VERSION, TASK_LINE_VERSION, type CreateEvent, type MovedEvent, type RegisterEvent, type StatusEvent, type TaskFields, type UpdateEvent } from '../register/events.ts';
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
// The week plan in force (the newest week tag started by now), which a reader's week steps follow, as `plan` does.
export { currentWeek } from '../register/week.ts';
// The done groups (T1729): one rule that sorts a span's done work for the daily report, the agenda and the Done page.
export { DONE_GROUP_KINDS, doneGroups, doneGroupTitle, URGENT_PRIORITY, type DoneGroup, type DoneGroupKind, type DoneGroups, type DoneGroupsInput, type DoneGroupTask } from '../register/done-groups.ts';
// The goal records (T1730): a team's goals with their planned window, target, every target move and rank (T2083),
// read from the `goals.jsonl` text beside the event log.
export { GOALS_FILE, NO_GOAL, NO_GOALS, readGoals, type Goal, type GoalSlip, type GoalsRead } from '../register/goals.ts';

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

// Waits on the owner: which tasks wait on the owner's decision or approval, which of those the lead asks now and which
// the owner put off (Later) until a time, and each session's cards grouped as `teamrig meet` asks them (T1295). The
// owner marker is the config's `register.ownerSource`, `requireGate` its `register.requireDecisionCard`.
export {
  asksOwner,
  deferredUntil,
  isUngated,
  ownerCardsBySession,
  ownerLater,
  waitsOnOwner,
  type LaterCard,
  type OwnerCards,
} from '../register/owner-waits.ts';

// The register's numbers over time (T1771): each day's flow, new work by source, lead and cycle times, due-date hits,
// waits, bugs and done per session for a team tree and a range, the tasks behind the Health counts (T1864), and the
// Health tiles over them with their levels, as `teamrig stats` prints them. The owner marker is the config's
// `register.ownerSource`.
export {
  isActive,
  isStatsRange,
  RECENT_DAYS,
  registerStats,
  STATS_ACTIVE_STATUSES,
  STATS_RANGES,
  WORK_SOURCES,
  type ActiveCounts,
  type ActiveStatus,
  type Band,
  type BugStats,
  type NewWork,
  type PersonDone,
  type RegisterStats,
  type Split,
  type Spread,
  type StatsDay,
  type StatsInput,
  type StatsRange,
  type StatsScope,
  type StatsTask,
  type StatsTasks,
  type StatsTeam,
  type TeamPart,
  type TeamStats,
  type WaitStats,
  type WorkSource,
} from '../register/stats.ts';
export {
  HEALTH_LEVELS,
  HEALTH_THRESHOLDS,
  registerHealth,
  type BacklogClearsTile,
  type BacklogTile,
  type CloseOpenTile,
  type HealthInput,
  type HealthLevel,
  type OverdueTile,
  type OwnerDecisionsTile,
  type RegisterHealth,
} from '../register/stats-health.ts';

// The inboxes (`inbox/<area>.md`) and their read marks (`inbox-marks.jsonl`).
export { indexMarks, MARK_VERSION, parseMark, readMarks, type InboxMark, type MarkIndex, type MarkLogRead } from '../inbox/marks.ts';
export { inboxLines, unreadOf, type LineHash, type ResumeKind, type Unread } from '../inbox/unread.ts';

// The kit config (`config.json`). DEFAULT_REGISTER is what a config that sets no `register` key gets,
// its priority names among them: a reader with no config to read names priorities from it.
export { DEFAULT_REGISTER } from '../config/defaults.ts';
export { priorityName } from '../config/priorities.ts';
export { parseConfigText, type ConfigRead } from '../config/text.ts';
export { CONFIG_VERSION, type FocusConfig, type KitConfig, type LaunchConfig, type PriorityConfig } from '../config/types.ts';

// The work class a task counts as (T2076): its own, else the team's `focus.defaultClass`, as the CLI reads it; and the
// best rank a task serves over its goals and their parents (T2083).
export { classOf, rankOf, type RankedGoal } from '../register/focus.ts';

// A session's launch settings: the model and effort it starts on (its `launch` entry, the lead's defaults under it), so
// a reader shows them as teamrig launches the session, in its words.
export { describeLaunch, launchOf } from '../config/launch.ts';

// Session names: the config's roster with the rename log (`renames.jsonl`), so a reader finds a session
// by its id, its name or a name it had before, as every teamrig command does; and the form people read a
// session in, `[acme] lead`, as the tab titles show it.
export { Roster, type SessionLookup } from '../config/roster.ts';
export { readRenames, RENAME_VERSION, type Rename, type RenameLogRead } from '../names/rename.ts';
export { bareName, sessionDisplay } from '../core/ids.ts';

// The lead tree: `roles.lead` over the sub-leads the config's `leads` names, so a reader shows a session's leader
// and a leader's group as teamrig's approvals and lists find them.
export { LeadTree } from '../config/lead-tree.ts';

// The team tree: each team config's `team.parent` link, read across the kit home's team folders, so a reader shows a
// team's parent, children and root as teamrig's routing and `list --tree` find them.
export { TeamTree, teamNodeOf, type TeamNode } from '../config/tree.ts';

// The hire log (`hires.jsonl`): who was hired for what job and who retired, so a reader marks a team's hired and
// retired sessions as teamrig's hire and retire commands count them.
export {
  activeHires,
  HIRE_FORMAT,
  readHiringLog,
  rehiredFrom,
  retiredSessions,
  type HireRecord,
  type HiringLogRead,
  type HiringRecord,
  type RetireRecord,
} from '../hiring/record.ts';

// Each team's week (`usage/team.week.json` in its state folder, `TEAM_WEEK_IN_STATE`; the config's `paths.state` can
// move that folder from `state/` under its home): its used and planned part of the account's week, as its budget hooks
// last read it, and the stretches the account sat at its usage limit. One file per team; a reader adds a child team's
// to its parent's.
export { parseTeamWeek, TEAM_WEEK_FORMAT, TEAM_WEEK_IN_STATE, type TeamWeekSummary } from '../budget/team-week-summary.ts';
export type { LimitSpan } from '../register/stats.ts';

// Each session's week (`usage/sessions.week.json` in its team's state folder, `SESSIONS_WEEK_IN_STATE`): its use of the
// account's week so far and its hours with work, by session id, as its team's budget hooks last read them.
export { parseSessionsWeek, SESSIONS_WEEK_FORMAT, SESSIONS_WEEK_IN_STATE, type SessionsWeekSummary, type SessionWeek } from '../budget/session-week-summary.ts';

// Each session's turn log (`turn-log/<session id>/<UTC hour>.jsonl`): its prompts, replies and clears, one parsed
// JSON line at a time.
export { parseEntry, TURN_LOG_VERSION, type TurnLogEntry, type TurnLogKind } from '../turn-log/entry.ts';
