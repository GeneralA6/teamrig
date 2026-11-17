/**
 * The team config keys the lead may change with `teamrig config set`, each by its full dotted path. It is an allow
 * list, so a key added to the schema later stays the owner's until someone lists it here (security's verdict on the
 * first gate list, which named keys by what they gate and missed a program teamrig runs and the pager's address).
 *
 * List a key only when changing it grants or takes away nothing a session may do, runs no program, moves no folder,
 * and leaves the budget, the host's shared resources and every guard as they are: those are owner gates (core rule 6).
 * Three listed keys rest on the lead's judgment and the docs say so: register.review.mode and register.review.requireOn
 * (which parts a bug's review needs) and github.repos (a repository gh migrate and issue comment may write to).
 * github.watcher, who hears the GitHub news no task owner takes, is staffing like the roster's work order, not a
 * permission: the loader refuses a name that is not one of the sessions, so a set cannot name one.
 */
export const LEAD_KEYS: ReadonlySet<string> = new Set([
  'messages.maxLines', 'messages.coldAfterMinutes',
  'register.goalPattern', 'register.goals', 'register.maxTitle', 'register.maxText', 'register.requireDescription',
  'register.requireEvidenceOnDone', 'register.requireSkillOnDone', 'register.requireNoteOn', 'register.requireFollowupsOn',
  'register.autoArchive', 'register.requireDecisionCard', 'register.requireProofOnVerifying', 'register.verifyGate',
  'register.maxVerifying', 'register.maxReparks', 'register.check.staleAfterHours', 'register.check.notPickedUpAfterHours',
  'register.check.prioritySkipAfterHours', 'register.check.maxSelfMadePerDay', 'register.check.goalProgressDays',
  'register.check.overSizeMultiple', 'register.check.weekLengthDays', 'register.check.stopgapFiles',
  'register.review.mode', 'register.review.requireOn', 'register.review.hintPattern',
  'skills.sharedPrefix', 'skills.maxDescriptionWords', 'skills.maxPerArea', 'skills.maxVerifiedAgeDays', 'skills.otherAreas',
  'contextFiles.maxClaudeMdChars', 'contextFiles.maxMemoryIndexChars', 'contextFiles.maxSkillListingChars',
  'contextFiles.maxSessionListsChars',
  'lock.ttlMs', 'lock.pollMs', 'lock.waitMs',
  'commits.maxLines', 'commits.maxFiles', 'commits.largeCommitTrailer', 'commits.testPatterns', 'commits.sourcePatterns',
  'delivery.checkTimeoutSeconds', 'delivery.freezes.maxMinutes', 'delivery.stablePeriods.settleMinutes',
  'delivery.stablePeriods.assumedDeployMinutes', 'delivery.stablePeriods.minMinutes', 'delivery.wait.pollSeconds',
  'delivery.wait.maxMinutes', 'delivery.schedule.resetBlackoutHours', 'delivery.schedule.queueCutoffUtc',
  'loops.chainNudgeAt',
  'wake.enabled', 'wake.priority', 'wake.batchSeconds', 'wake.minGapMinutes', 'wake.dayStartUtc',
  'tests.maxFailureChars',
  'github.repos', 'github.watcher', 'github.closedDays', 'github.probeSeconds', 'github.similarThreshold', 'github.acceptLabel',
  'decisions.batchTimesUtc', 'decisions.batchAt',
  'tabStatus.enabled',
  'needsYou.enabled', 'needsYou.kinds', 'needsYou.osToast',
  'meeting.panel.enabled', 'meeting.spotlight.enabled', 'meeting.spotlight.dim', 'meeting.spotlight.breakthroughSeconds',
  'meeting.statusLine.enabled', 'meeting.statusLine.colour', 'meeting.statusLine.heldText',
  'turnLog.enabled', 'turnLog.keepHours',
  'meetingNotices.enabled', 'meetingNotices.beforeMinutes', 'meetingNotices.atStart', 'meetingNotices.missedAfterMinutes',
  'meetingNotices.osToast', 'meetingNotices.tabToast', 'meetingNotices.leadInbox',
  'open.terminal', 'open.teamWindow',
  'statusLine.folder', 'statusLine.branch', 'statusLine.pace',
  'focus.classes', 'focus.roadmapClass', 'focus.maintenanceClass', 'focus.defaultClass', 'focus.maxActiveKeyResults',
  'focus.slicesPerSession', 'focus.maxOwnerDecisions', 'focus.score.rankValues', 'focus.score.roadmapUnranked',
  'focus.score.maintenanceValue', 'focus.score.maintenanceBug', 'focus.score.maintenanceCritical',
  'focus.score.improvementsValue', 'focus.score.overdueValue', 'focus.score.dueSoonValue', 'focus.score.dueSoonDays',
  'focus.score.unblocksShare', 'focus.score.ownerOrderValues', 'focus.score.defaultSizePct', 'focus.score.minSizePct',
  'focus.expedite.critical', 'focus.expedite.ownerP1', 'focus.wip.mode', 'focus.wip.maxInProgress',
  'focus.leaderWaitMinutes', 'focus.parkAfterDays', 'focus.plannedTargetPct', 'focus.improvementsDay',
  'refresh.enabled', 'refresh.contextTokens', 'refresh.everyTasks', 'refresh.everyTasksMinTokens', 'refresh.tabTitle',
  'refresh.restartDelaySeconds', 'refresh.holdAfterActivityMinutes', 'refresh.countdownSeconds',
  'refresh.compactCeilingTokens', 'refresh.handoverMaxBytes',
  'hiring.reviewDays', 'hiring.resumeMaxTokens', 'hiring.resumeMaxIdleDays', 'hiring.scaleOut.windowDays',
  'hiring.scaleOut.minDone', 'hiring.scaleOut.topPriorities',
]);
