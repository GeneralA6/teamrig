import { tmpdir } from 'node:os';
import { launchOf } from '../../config/launch.ts';
import { LeadTree } from '../../config/lead-tree.ts';
import { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { recordConfigDir } from '../../budget/config-dir.ts';
import { errorMessage, isRecord, stringField, type JsonRecord } from '../../core/guards.ts';
import { claudeConfigDir, claudeTempDir, KIT_NAME, resolveKitHome } from '../../core/home.ts';
import type { TimeZone } from '../../core/zone.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import { routeReminderOf } from '../../inbox/route.ts';
import { boundPromptNote, boundStartNote, tabTitleFor } from '../../hooks/bind.ts';
import { modelCheckLine, payloadEffortOf } from '../../hooks/model-check.ts';
import { ModelNoticeStore } from '../../hooks/model-notices.ts';
import { sendTargetOf } from '../../hooks/cold-send.ts';
import { failedSendLine, failedSendOf } from '../../hooks/failed-send.ts';
import { deliveredSendOf } from '../../hooks/route-reminder.ts';
import { postToolUseContext } from '../../hooks/post-tool-use.ts';
import { passRecordGuardOutput } from '../../hooks/pass-record-guard.ts';
import { JsonlHintLog } from '../../hooks/hint-log.ts';
import { promptOutput } from '../../hooks/prompt-output.ts';
import { liveTasksPointer, showsLiveTasks } from '../../hooks/live-tasks.ts';
import { requirementsNoteOnce } from '../../hooks/requirements-note.ts';
import { helperOf } from '../../hooks/helper-start.ts';
import { sessionStartContext, sessionStartOutput, type CuttableNote, type SessionStartInput } from '../../hooks/session-start.ts';
import { worktreeNoteOf } from '../../hooks/worktree-note.ts';
import { stopModelNotices } from '../../hooks/stop-model.ts';
import { leadStopLine, leadTallyOf } from '../../hooks/lead-boundary.ts';
import { turnToolsOf } from '../../hooks/loop-nudge.ts';
import { blockOutput, stopOutput } from '../../hooks/stop.ts';
import { adoptTitle, promptNote, sessionStartNote, type TitleOutcome } from '../../names/detect.ts';
import { JsonlRenameLog } from '../../names/log.ts';
import { TRANSCRIPT_TAIL_BYTES } from '../../names/title.ts';
import {
  decideStart,
  decideStop,
  reaskGrowth,
  thousands,
  type DueFacts,
  type StopContext,
  type StopDecision,
  type StopFacts,
} from '../../refresh/decide.ts';
import { carryLines, carryStartOf, readCarry, type CarriedCron, type Carry, type CarryPlaces, type CarryStart } from '../../refresh/carry.ts';
import { claudeProcessOf } from '../../refresh/restart.ts';
import { RefreshStore } from '../../refresh/store.ts';
import { readContextTokens } from '../../refresh/usage.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { hookLogOf } from '../hook-logs.ts';
import { openKit, renameDepsOf, rosterOf, rulesClockOf, teamZone, type Kit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { keptRulesAboveOf, readTeamRules } from '../team-rules.ts';
import { loadTree } from '../tree.ts';
import { bindAfterClear, bindHintOnce, bindNamedTab, bindTab, inboxLinesFor, readTitle, type TitleRead } from './hook-bind.ts';
import { helperGateOutput, promptBudgetLine, stopBudgetLines } from './hook-budget.ts';
import { leaderDigestText } from './hook-leader-digest.ts';
import { startAutoSync } from './gh-auto.ts';
import { closedSendHold } from './hook-closed-send.ts';
import { coldSendHold } from './hook-cold-send.ts';
import { blockStartOf, liveTasksNoteOf } from './live-tasks.ts';
import { droppedEditReasonOf } from './hook-dropped-edit.ts';
import { effortWritebackOf, type EffortWritebackOutcome } from './hook-effort-writeback.ts';
import { meetingHold } from './hook-meeting.ts';
import { restartOrPark, restartTargetOf } from './hook-restart.ts';
import { helperContextOf } from './hook-helper-start.ts';
import { promptSecretBlock } from './hook-prompt-secret.ts';
import { guardLoadOf, hookTeam } from './hook-guard-load.ts';
import { execGuardOutputOf, packageGuardOutputOf, pushGuardOutputOf, secretGuardOutputOf } from './hook-guard-outputs.ts';
import { checkHooklessTabs } from './hook-hookless.ts';
import { dueFactsAt, inMeetingNow } from './hook-refresh-mod.ts';
import { recordSessionStart } from './hook-session-record.ts';
import { envSession, hookScopeOf, parseJson, sessionScopeOf, sessionTeam, startSessionOf, teamScopeOf, teamSessionOf, turnLeadPathsOf, type SessionScope, type TeamScope } from './hook-input.ts';
import { recordTabNeed } from './hook-tab-need.ts';
import { tabStatusOn, tabTitleOf } from './hook-tab-status.ts';
import { logPrompt, logReply, logStart } from './hook-turn-log.ts';
import { keepWorkingReasonOf } from './keep-working.ts';
import { lastTaskAskReasonOf } from './last-task-ask.ts';
import { verifyByLinesOf, verifyStartNoteOf } from './verify-queue.ts';

/**
 * Claude Code hooks. Each reads the hook's JSON from stdin and prints only what Claude Code
 * should act on, and never refuses: a refusal exits 2, which would block the tool call. A plugin
 * enabled for the user fires in every project, so outside a team's projects each hook prints
 * nothing at all.
 */

/** PreToolUse on Bash and PowerShell: asks before a push to a protected branch, refuses a force-push of one. */
export async function pushGuard(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const guard = await guardLoadOf(payload, runtime);
  if (guard === undefined) {
    return EXIT.ok;
  }
  const output = await pushGuardOutputOf(runtime, guard, payload);
  if (output !== '') {
    runtime.out.stdout(output);
  }
  return EXIT.ok;
}

/**
 * PreToolUse on Bash and PowerShell: refuses, or asks about, a package runner that would fetch and run a package ad hoc,
 * and an install of a version the registry does not vouch for (too young, with an advisory, or not exact); refuses a
 * package-manager call that would rewrite node_modules through a link (a worktree's junction to the main checkout's).
 */
export async function packageGuard(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const guard = await guardLoadOf(payload, runtime);
  if (guard === undefined) {
    return EXIT.ok;
  }
  const output = await packageGuardOutputOf(runtime, guard, payload);
  if (output !== '') {
    runtime.out.stdout(output);
  }
  return EXIT.ok;
}

/**
 * PreToolUse on Bash, PowerShell, Read, Grep and the file-writing tools: refuses, or asks about, a call that would print
 * a secret into the conversation, or whose line or written text holds one.
 */
export async function secretGuard(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const guard = await guardLoadOf(payload, runtime);
  if (guard === undefined) {
    return EXIT.ok;
  }
  const output = secretGuardOutputOf(runtime, guard, payload);
  if (output !== '') {
    runtime.out.stdout(output);
  }
  return EXIT.ok;
}

/** PreToolUse on Bash, PowerShell and the file-writing tools: refuses a session's own write of a tree's pass record. */
export async function passRecordGuard(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  if ((await hookTeam(payload, runtime)).kind === 'none') {
    return EXIT.ok;
  }
  const output = passRecordGuardOutput(payload);
  if (output !== '') {
    runtime.out.stdout(output);
  }
  return EXIT.ok;
}

/**
 * PreToolUse on Bash and PowerShell: refuses a `teamrig exec` review (approve, refuse, escalate) run as anyone but the
 * tab's own session, any `teamrig exec` call through a client that is no install of this plugin, or one whose files
 * differ from its build, and every `teamrig owner` call, which acts as the owner.
 */
export async function execGuard(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const guard = await guardLoadOf(payload, runtime);
  if (guard === undefined) {
    return EXIT.ok;
  }
  const output = await execGuardOutputOf(runtime, guard, payload);
  if (output !== '') {
    runtime.out.stdout(output);
  }
  return EXIT.ok;
}

/**
 * A Claude Code rename (`--name`, `/rename`) of the session becomes its new team name: recorded in
 * the rename log, never by moving data. It never throws, so the hook always answers; a failure is
 * retried on the next prompt.
 */
async function titleOutcome(runtime: CliRuntime, kit: Kit, config: KitConfig, payload: unknown, read: TitleRead): Promise<TitleOutcome> {
  if (read.kind === 'failed') {
    return { kind: 'failed', error: read.error };
  }
  const { title } = read;
  try {
    if (title === undefined) {
      return { kind: 'none' };
    }
    const roster = await rosterOf(runtime, kit, config);
    const id = await teamSessionOf(runtime, kit, roster, sessionIdOf(payload));
    return id === undefined ? { kind: 'none' } : await adoptTitle(renameDepsOf(runtime, kit, config), { team: kit.paths.team, roster }, id, title);
  } catch (error) {
    return { kind: 'failed', error: errorMessage(error) };
  }
}

/**
 * A prompt typed while the automatic restart waits for the session to be idle, or is held back until a wake brings it
 * work (T1383), cancels it, so the session keeps its context; one line tells the model, with the context growth
 * (`growth` tokens) that asks again. None when no restart waits, or one is already ending the session.
 */
async function cancelledRestartLine(runtime: CliRuntime, kit: Kit, id: string, growth: number): Promise<string | undefined> {
  const store = new RefreshStore(runtime.files, kit.paths);
  const parked = (await store.parked(id)) !== undefined;
  const pending = (await store.restart(id))?.phase === 'pending';
  if (parked) {
    await store.clearParked(id);
  }
  if (pending) {
    await store.clearRestart(id);
  }
  return parked || pending
    ? `${KIT_NAME}: the user typed, so the automatic restart is cancelled and you keep this context; a new handover is asked at your next task end, or once your context grew ${thousands(growth)} more`
    : undefined;
}

/**
 * UserPromptSubmit: first stops a prompt that holds a secret, in a team or under a broken pointer, and cleans it out
 * of Claude Code's prompt history (hook-prompt-secret.ts); a stopped prompt gets nothing below. Else it
 * logs a team session's prompt for the task pane (hook-turn-log.ts), cancels a pending
 * automatic restart, binds a hand-started tab by its title, notes a Claude Code rename of the session, titles a
 * bound tab that has no title after its session (so a /clear keeps it bound), says once how to bind a tab that is
 * not bound, shows the session's new inbox lines, to a leader the register changes in its tree since its last prompt
 * (hook-leader-digest.ts) and, once per level while it is past its daily budget and the
 * team is ahead of its pace line, tells the model to finish the step in hand; or one line when its team pointer
 * is broken.
 */
export async function inboxReminder(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const claudeSession = sessionIdOf(payload);
  if (claudeSession === null) {
    return EXIT.ok;
  }
  const found = await sessionTeam(payload, runtime);
  switch (found.kind) {
    case 'none':
      return EXIT.ok;
    case 'broken': {
      // A broken pointer still guards the prompt, with the shipped secret shapes only.
      const block = await promptSecretBlock(runtime, { kitHome: resolveKitHome(runtime.env, runtime.userHome), patterns: [] }, claudeSession, payload);
      runtime.out.stdout(block ?? `${KIT_NAME}: no team, so no inbox reminder: ${found.from} ${found.problem}`);
      return EXIT.ok;
    }
    case 'team':
      break;
  }
  const kit = await openKit(runtime, found.team);
  const patterns = kit.load.status === 'loaded' ? kit.load.config.register.secretPatterns : [];
  // Before anything reads the prompt: a stopped prompt is neither logged nor shown its inbox lines, which stay unshown.
  const block = await promptSecretBlock(runtime, { kitHome: kit.paths.kitHome, patterns }, claudeSession, payload);
  if (block !== undefined) {
    runtime.out.stdout(block);
    return EXIT.ok;
  }
  if (kit.load.status !== 'loaded') {
    return EXIT.ok;
  }
  const { config } = kit.load;
  const title = await readTitle(runtime, payload);
  const own = { team: kit.paths.team, roster: await rosterOf(runtime, kit, config) };
  const binding = await bindTab(runtime, kit, own, claudeSession, title);
  const bound = boundPromptNote(binding.outcome, own, KIT_NAME);
  const renamed = promptNote(await titleOutcome(runtime, kit, config, payload, title), KIT_NAME);
  const hint = await bindHintOnce(runtime, kit, binding, claudeSession);
  // Found like a rename: `$TEAMRIG_SESSION` first, so a session is shown its lines before its first `inbox read`.
  const session = await teamSessionOf(runtime, kit, own.roster, claudeSession);
  if (session !== undefined) {
    await logPrompt(runtime, { config, paths: kit.paths, id: session }, payload).catch(() => undefined);
  }
  const cancelled = session === undefined ? undefined : await cancelledRestartLine(runtime, kit, session, reaskGrowth(config.refresh)).catch(() => undefined);
  const budgetLine = session === undefined ? undefined : await promptBudgetLine(runtime, { kit, config, roster: own.roster, id: session }).catch(() => undefined);
  // Like the inbox lines below, reading the digest moves its cursor, so it is read late; only a leader gets one.
  const digest = session === undefined ? undefined : await leaderDigestText(runtime, kit.paths, config, session).catch(() => undefined);
  // Read last, as reading marks the lines shown: a hook killed at its timeout before printing must leave them unshown.
  const lines = session === undefined ? undefined : await inboxLinesFor(runtime, kit, session, claudeSession, teamZone(config, runtime));
  // An unreadable title may be one the user set, so only a title read as absent is given.
  const tabTitle = title.kind === 'read' ? tabTitleFor(own.roster, session, title.title) : undefined;
  const texts = [bound, renamed, hint, cancelled, lines, digest, budgetLine].filter((text): text is string => text !== undefined);
  for (const text of promptOutput(texts, tabTitle)) {
    runtime.out.stdout(text);
  }
  return EXIT.ok;
}

/**
 * PreToolUse on SendMessage: while the owner's daily meeting is open, holds every message to the lead but a
 * CRITICAL one (hook-meeting.ts); otherwise, while the idle pass reopens sessions, turns a message to a session
 * teamrig closed into its urgent line (hook-closed-send.ts), checked before the cold hold, which would read the
 * closed session's old transcript as idle; otherwise holds once a message to a team session idle
 * `messages.coldAfterMinutes` or longer, which would wake it cold, and the same tab's next send to it goes
 * through. Outside a loaded team it prints nothing.
 */
export async function coldSend(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const claudeSession = sessionIdOf(payload);
  if (claudeSession === null || sendTargetOf(payload) === undefined) {
    return EXIT.ok;
  }
  const found = await sessionTeam(payload, runtime);
  if (found.kind !== 'team') {
    return EXIT.ok;
  }
  const kit = await openKit(runtime, found.team);
  if (kit.load.status !== 'loaded') {
    return EXIT.ok;
  }
  const { config } = kit.load;
  const roster = await rosterOf(runtime, kit, config);
  const hold =
    (await meetingHold(runtime, kit, config, roster, payload, claudeSession)) ??
    (await closedSendHold(runtime, kit, config, roster, payload, claudeSession)) ??
    (await coldSendHold(runtime, kit, config, roster, payload, claudeSession));
  if (hold !== undefined) {
    runtime.out.stdout(hold);
  }
  return EXIT.ok;
}

/**
 * PostToolUse on SendMessage: after a send that was not delivered (no live session answers to the name),
 * hands the model one line to leave the message as an inbox line instead, so it is not lost. Outside a
 * loaded team it prints nothing.
 */
export async function failedSend(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const failed = failedSendOf(payload);
  if (failed === undefined) {
    return EXIT.ok;
  }
  const found = await sessionTeam(payload, runtime);
  if (found.kind !== 'team') {
    return EXIT.ok;
  }
  const kit = await openKit(runtime, found.team);
  if (kit.load.status !== 'loaded') {
    return EXIT.ok;
  }
  const receiver = (await rosterOf(runtime, kit, kit.load.config)).lookup(failed.to);
  runtime.out.stdout(postToolUseContext(failedSendLine(failed, receiver.ok ? receiver.id : undefined, KIT_NAME, kit.load.config.wake.enabled)));
  return EXIT.ok;
}

/**
 * PostToolUse on SendMessage (T783): after a delivered message to a session under a sub-lead below the sender, hands
 * the model one line to route such work via that sub-lead next time, naming sessions by the names they are messaged
 * by. A CRITICAL message, a send to or from no team session, or anything outside a loaded team gets nothing.
 */
export async function routeReminder(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const sent = deliveredSendOf(payload);
  if (sent === undefined || !isRecord(payload)) {
    return EXIT.ok;
  }
  const found = await sessionTeam(payload, runtime);
  if (found.kind !== 'team') {
    return EXIT.ok;
  }
  const kit = await openKit(runtime, found.team);
  if (kit.load.status !== 'loaded') {
    return EXIT.ok;
  }
  const { config } = kit.load;
  const roster = await rosterOf(runtime, kit, config);
  const receiver = roster.lookup(sent.to);
  const sender = await teamSessionOf(runtime, kit, roster, sessionIdOf(payload));
  if (!receiver.ok || sender === undefined) {
    return EXIT.ok;
  }
  const message = { from: sender, to: receiver.id, text: sent.text };
  const line = routeReminderOf(new LeadTree(config), message, (id) => roster.nameOf(id) ?? id, KIT_NAME);
  if (line !== undefined) {
    runtime.out.stdout(postToolUseContext(line));
  }
  return EXIT.ok;
}

/**
 * PreToolUse on Agent (and the older Task): asks the person before a helper launch, or refuses it, when
 * the session is past its daily budget while the team is ahead of its pace line, or in the team's quiet
 * hours, as `budget.overAction` and `budget.quietHours` say. The lead and a lifted session always go
 * ahead. Outside a loaded team, with the budget off or on any error it prints nothing.
 */
export async function helperGateHook(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  if (!isRecord(payload)) {
    return EXIT.ok;
  }
  const output = await helperGateOf(runtime, payload).catch(() => undefined);
  if (output !== undefined) {
    runtime.out.stdout(output);
  }
  return EXIT.ok;
}

async function helperGateOf(runtime: CliRuntime, payload: JsonRecord): Promise<string | undefined> {
  const scope = await hookScopeOf(runtime, payload);
  return scope === undefined ? undefined : helperGateOutput(runtime, scope, stringField(payload, 'transcript_path'));
}

type TeamParts = Pick<
  SessionStartInput,
  'teamRules' | 'keptRulesAbove' | 'renames' | 'titleNote' | 'refreshNote' | 'liveTasksNote' | 'modelNote' | 'verifyNote' | 'duplicateNote' | 'worktreeNote' | 'session' | 'sessionInEnv' | 'tree'
> & {
  /** Why the start's Claude Code process could not be recorded; undefined when it was, or there was nothing to record. */
  readonly recordNote: string | undefined;
  /** Why the tab `$TEAMRIG_SESSION` names could not be bound to its session; undefined when it was, or nothing names it. */
  readonly envBindNote: string | undefined;
};

/**
 * The rules.md of a loaded team and of each team above it, the kept local rules of those above, and its rename log, after binding a hand-started tab by its Claude Code title
 * and recording a Claude Code rename of the session; the pointer to its handover after a refresh; who
 * the session is: `$TEAMRIG_SESSION`, else the area it read its inbox as or was bound to, so a tab that
 * set the team up keeps its identity across a compact or resume; after a refresh or a compaction its live
 * tasks; whether it runs on its configured model and effort; its verifying tasks; and where the team sits
 * in a tree of teams, read from every team config of the kit home. It records the Claude Code process the session
 * started in and the team's Claude config dir (budget/config-dir.ts), binds a tab `$TEAMRIG_SESSION` names to that session in the inbox marks, marks a /clear or a compaction in the session's turn log and prunes the log's old hours (hook-turn-log.ts).
 */
async function teamPartsOf(runtime: CliRuntime, kit: Kit, config: KitConfig, payload: unknown): Promise<TeamParts> {
  const title = await readTitle(runtime, payload);
  const claudeSession = sessionIdOf(payload);
  const bound = claudeSession === null ? undefined : await startBindNoteOf(runtime, kit, config, payload, claudeSession, title);
  const renamed = sessionStartNote(await titleOutcome(runtime, kit, config, payload, title));
  const titleNote = bound === undefined || renamed === undefined ? (bound ?? renamed) : `${bound} ${renamed}`;
  const { renames } = await new JsonlRenameLog(runtime.files, kit.paths.renames).read();
  const roster = new Roster(config, kit.paths.team, renames);
  const refresh = await refreshStartOf(runtime, kit, config, roster, payload);
  const fromEnv = envSession(runtime);
  const kitTree = await loadTree(runtime);
  const session = fromEnv ?? (await startSessionOf(runtime, kit, roster, payload));
  const id = rosterIdOf(roster, session);
  if (id !== undefined) {
    await logStart(runtime, { config, paths: kit.paths, id }, payload).catch(() => undefined);
    await recordConfigDir(runtime.files, kit.paths.configDirRecord, claudeConfigDir(runtime.env, runtime.userHome)).catch(() => undefined);
  }
  const recorded = id === undefined || claudeSession === null ? undefined : await recordSessionStart(runtime, kit, roster.ids, id, claudeSession, startTranscriptOf(payload));
  const envBindNote = fromEnv === undefined || id === undefined || claudeSession === null ? undefined : await bindNamedTab(runtime, kit, id, claudeSession);
  return {
    recordNote: recorded?.failure,
    envBindNote,
    duplicateNote: recorded?.duplicate,
    teamRules: await readTeamRules(runtime, kit, kitTree),
    keptRulesAbove: keptRulesAboveOf(kit, kitTree),
    renames,
    titleNote,
    refreshNote: refresh.note,
    liveTasksNote: await liveTasksPartOf(runtime, kit, config, id, payload, refresh),
    modelNote: modelNoteOf(config, roster, id, payload),
    verifyNote: await verifyStartNoteOf(runtime, kit.paths, id),
    worktreeNote: worktreeNoteOf(isRecord(payload) ? stringField(payload, 'cwd') : undefined),
    session,
    sessionInEnv: fromEnv !== undefined,
    tree: kitTree.tree.placeOf(kit.paths.team),
  };
}

/**
 * The SessionStart note for a tab bound as it started: by its title, else, after a /clear, by the Claude
 * Code process its session refreshed in (a /clear keeps the process; the title may name no session).
 */
async function startBindNoteOf(runtime: CliRuntime, kit: Kit, config: KitConfig, payload: unknown, claudeSession: string, title: TitleRead): Promise<string | undefined> {
  const roster = await rosterOf(runtime, kit, config);
  const { outcome } = await bindTab(runtime, kit, { team: kit.paths.team, roster }, claudeSession, title);
  const source = isRecord(payload) ? stringField(payload, 'source') : undefined;
  if (source !== 'clear' || outcome.kind === 'kept' || outcome.kind === 'bound') {
    return boundStartNote(outcome);
  }
  return bindAfterClear(runtime, kit, roster, claudeSession);
}

/**
 * The line for a session of the team that runs on another model than its `launch` entry (for the
 * lead, unset: `opus`), from the payload's model; Claude Code leaves it out at some starts, and then
 * nothing is checked. The effort is checked at the first Stop: SessionStart gets no effort level, and
 * `$CLAUDE_EFFORT` here can be the value of the session whose shell started this one.
 */
function modelNoteOf(config: KitConfig, roster: Roster, id: string | undefined, payload: unknown): string | undefined {
  if (id === undefined) {
    return undefined;
  }
  const running = { model: isRecord(payload) ? stringField(payload, 'model') : undefined, effort: undefined };
  return modelCheckLine(roster.nameOf(id) ?? id, launchOf(config, id), running);
}

/** The team session an id or any name it has had finds; undefined for none, or a name the team does not know. */
function rosterIdOf(roster: Roster, session: string | undefined): string | undefined {
  const found = session === undefined ? undefined : roster.lookup(session);
  return found?.ok === true ? found.id : undefined;
}

function carryPlaces(runtime: CliRuntime): CarryPlaces {
  return { tempDir: claudeTempDir(runtime.env, tmpdir()), claudeDir: claudeConfigDir(runtime.env, runtime.userHome) };
}

/** The fresh session's transcript, from the SessionStart payload. */
function startTranscriptOf(payload: unknown): string | undefined {
  return isRecord(payload) ? stringField(payload, 'transcript_path') : undefined;
}

function carryRecordFailed(error: unknown): string {
  return `${KIT_NAME} could not keep its record of the jobs your /clear kept (${errorMessage(error)}); after a new process, check CronList against your handover.`;
}

/** What the old transcript leaves (undefined when it is gone), and the jobs an earlier /clear left live in its process. */
interface CarryRead {
  readonly carry: Carry | undefined;
  readonly inherited: readonly CarriedCron[];
}

async function carryFrom(runtime: CliRuntime, store: RefreshStore, id: string, transcript: string, now: number): Promise<CarryRead> {
  const record = await store.carried(id);
  const inherited = record?.transcript === transcript ? record.crons : [];
  return { carry: await readCarry(runtime.files, transcript, now, carryPlaces(runtime), inherited), inherited };
}

/**
 * Records the jobs a /clear leaves live in the process for the fresh session's transcript, which never names them,
 * so the next refresh counts them (T657); a new process ends them, so it keeps none.
 */
async function keepCarried(store: RefreshStore, id: string, crons: readonly CarriedCron[], start: CarryStart, fresh: string | undefined): Promise<void> {
  if (start === 'same-process' && fresh !== undefined && crons.length > 0) {
    await store.setCarried(id, { transcript: fresh, crons });
  } else {
    await store.clearCarried(id);
  }
}

/**
 * What the session that wrote the handover leaves for this fresh one: its scheduled jobs (kept by a /clear,
 * lost with a new process), counted from those an earlier /clear left live in its process, and wake-up, and its
 * scratchpad and plan file; a /clear records its jobs for the next refresh. A transcript it cannot read, or a
 * record it cannot write, is said, never thrown: the note itself must still reach the session.
 */
async function carriedLinesOf(runtime: CliRuntime, store: RefreshStore, id: string, transcript: string, payload: unknown, zone: TimeZone): Promise<readonly string[]> {
  const now = runtime.clock.now();
  const start = carryStartOf(isRecord(payload) ? stringField(payload, 'source') : undefined);
  let read: CarryRead;
  try {
    read = await carryFrom(runtime, store, id, transcript, now);
  } catch (error) {
    return [`${KIT_NAME} could not read what your old session left in ${transcript} (${errorMessage(error)}); check CronList against your handover.`];
  }
  const lines = read.carry === undefined ? [] : carryLines(read.carry, now, start, zone);
  try {
    await keepCarried(store, id, read.carry?.crons ?? read.inherited, start, startTranscriptOf(payload));
    return lines;
  } catch (error) {
    return [...lines, carryRecordFailed(error)];
  }
}

/**
 * Keeps the record of the jobs live in the session's process at a start the refresh did not carry: a /clear moves
 * it on to the fresh transcript with the jobs the cleared session made, a compaction keeps the transcript and the
 * record, and a new process ends them all. Says, never throws, when it cannot.
 */
async function carryRecordAt(runtime: CliRuntime, store: RefreshStore, id: string, payload: unknown): Promise<string | undefined> {
  const source = isRecord(payload) ? stringField(payload, 'source') : undefined;
  if (source === undefined || source === 'compact') {
    return undefined;
  }
  try {
    if (carryStartOf(source) === 'new-process') {
      await store.clearCarried(id);
      return undefined;
    }
    const record = await store.carried(id);
    if (record !== undefined) {
      const carry = await readCarry(runtime.files, record.transcript, runtime.clock.now(), carryPlaces(runtime), record.crons);
      await keepCarried(store, id, carry?.crons ?? record.crons, 'same-process', startTranscriptOf(payload));
    }
    return undefined;
  } catch (error) {
    return carryRecordFailed(error);
  }
}

/** What a start says about the context refresh: its note, and whether this is the fresh start a handover was written for. */
interface RefreshStart {
  readonly note: string | undefined;
  readonly refreshed: boolean;
}

const NO_REFRESH: RefreshStart = { note: undefined, refreshed: false };

/**
 * A fresh start (`/clear`, a new process) after the session's handover was marked ready: the note
 * that points it at the handover, given once. A start that keeps the old context (compact, resume)
 * leaves the handover waiting; a small context again (a compaction too) starts the task count over.
 * It never throws, so the session always gets its rules.
 */
async function refreshStartOf(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, payload: unknown): Promise<RefreshStart> {
  try {
    const id = await teamSessionOf(runtime, kit, roster, sessionIdOf(payload));
    if (id === undefined) {
      return NO_REFRESH;
    }
    const store = new RefreshStore(runtime.files, kit.paths);
    const source = isRecord(payload) ? stringField(payload, 'source') : undefined;
    const now = new Date(runtime.clock.now()).toISOString();
    const state = await store.state(id);
    const decision = decideStart(state, source, config.refresh, store.handoverPath(id), now);
    if (decision.kind !== 'inject') {
      if (decision.kind === 'reset') {
        await store.setState(id, decision.state);
      }
      const recordNote = config.refresh.enabled ? await carryRecordAt(runtime, store, id, payload) : undefined;
      return recordNote === undefined ? NO_REFRESH : { note: recordNote, refreshed: false };
    }
    await store.setState(id, decision.state);
    await store.clearRequest(id);
    const carried =
      state?.phase === 'ready' && state.transcript !== null
        ? await carriedLinesOf(runtime, store, id, state.transcript, payload, teamZone(config, runtime))
        : [await carryRecordAt(runtime, store, id, payload)].filter((line) => line !== undefined);
    return { note: [decision.note, ...carried].join('\n'), refreshed: true };
  } catch (error) {
    return { note: `${KIT_NAME} could not check for a refresh handover (${errorMessage(error)}); if you wrote one before a /clear, read it first.`, refreshed: false };
  }
}

/**
 * The live-task block (hooks/live-tasks.ts) at the fresh start after a refresh and after a compaction, after `start`'s
 * first lines, which make it the work block's start (T1529), with its pointer for a start that has no room for it (which
 * names `start` instead); none at another start or for no session.
 */
async function liveTasksPartOf(runtime: CliRuntime, kit: Kit, config: KitConfig, id: string | undefined, payload: unknown, refresh: RefreshStart): Promise<CuttableNote | undefined> {
  const source = isRecord(payload) ? stringField(payload, 'source') : undefined;
  if (id === undefined || !showsLiveTasks(source, refresh.refreshed)) {
    return undefined;
  }
  const start = await blockStartOf(runtime, kit, config, id);
  return { text: await liveTasksNoteOf(runtime, kit.paths, config, id, teamZone(config, runtime), start), pointer: liveTasksPointer(id, KIT_NAME) };
}

/** The refresh facts every turn end may need: the lead's request, the context size from the transcript's tail, and the open meeting. */
async function stopFactsOf(runtime: CliRuntime, scope: SessionScope, store: RefreshStore, payload: JsonRecord): Promise<StopFacts> {
  const { roster, id } = scope;
  const request = await store.request(id);
  const transcript = stringField(payload, 'transcript_path');
  return {
    requestedBy: request === undefined ? undefined : (roster.nameOf(request.by) ?? request.by),
    tokens: transcript === undefined ? undefined : await readContextTokens(runtime.files, transcript),
    meeting: await inMeetingNow(runtime, scope),
    due: undefined,
  };
}

/** The facts a due refresh or notice reads (`dueFactsAt`), the running work from the transcript Claude Code gave the hook. */
function dueFactsOf(runtime: CliRuntime, store: RefreshStore, id: string, payload: JsonRecord): Promise<DueFacts> {
  return dueFactsAt(runtime, store, id, stringField(payload, 'transcript_path'));
}

/** The owner's turn-end line when the lead did hand-off work itself (lead-boundary.ts); none for another session, with the boundary off or without a transcript. */
async function leadStopLines(runtime: CliRuntime, scope: SessionScope, transcript: string | undefined): Promise<readonly string[]> {
  const { kit, config, id } = scope;
  if (!config.leadBoundary.enabled || id !== config.roles.lead || transcript === undefined) {
    return [];
  }
  const text = await runtime.files.readTail(transcript, TRANSCRIPT_TAIL_BYTES);
  if (text === undefined) {
    return [];
  }
  const turn = turnToolsOf(text, Buffer.byteLength(text, 'utf8') >= TRANSCRIPT_TAIL_BYTES, undefined);
  const line = leadStopLine(leadTallyOf(turn, await turnLeadPathsOf(runtime, kit, config, await loadTree(runtime), turn)), config.leadBoundary.searchNudgeAt);
  return line === undefined ? [] : [line];
}

/** The refresh decision for this turn's end; none with refresh off. */
async function refreshDecisionOf(runtime: CliRuntime, scope: SessionScope, payload: JsonRecord): Promise<StopDecision> {
  const { kit, config, roster, id } = scope;
  if (!config.refresh.enabled) {
    return { kind: 'none' };
  }
  const store = new RefreshStore(runtime.files, kit.paths);
  const state = await store.state(id);
  if (state?.phase === 'ready' && state.noticed) {
    // A turn after the notice: the session went on from its context, so a restart held back for work is stale (T1383).
    await store.clearParked(id);
  }
  const target = restartTargetOf(runtime, payload);
  const context: StopContext = {
    stopHookActive: payload['stop_hook_active'] === true,
    settings: config.refresh,
    now: new Date(runtime.clock.now()).toISOString(),
    session: { id, team: kit.paths.team, name: roster.nameOf(id) ?? id },
    handoverPath: store.handoverPath(id),
    command: KIT_NAME,
    canRestart: config.refresh.autoRestart && target !== undefined,
    transcript: stringField(payload, 'transcript_path') ?? null,
  };
  // The facts are read only as far as the decision needs them: most turn ends stop at the transcript's tail.
  const first = decideStop(state, context);
  const facts = first.kind === 'measure' ? await stopFactsOf(runtime, scope, store, payload) : undefined;
  const measured = facts === undefined ? first : decideStop(state, context, facts);
  const decided =
    facts !== undefined && measured.kind === 'measure' ? decideStop(state, context, { ...facts, due: await dueFactsOf(runtime, store, id, payload) }) : measured;
  // Looked up once for the restart and the state: each look at a process starts a PowerShell on Windows, and a Stop
  // hook past Claude Code's timeout is killed with every process it started.
  const claude = decided.kind === 'notice' ? await claudeProcessOf(runtime.sessionProcesses, runtime.sessionProcesses.parentPid) : undefined;
  const decision =
    decided.kind === 'notice' && decided.restart && target !== undefined
      ? await restartOrPark(runtime, store, { team: kit.paths.team, id, context, target, claude }, decided, { paths: kit.paths, config })
      : decided;
  switch (decision.kind) {
    case 'write':
    case 'block':
      // Written before anything is printed: a block whose state is not recorded would ask again at every stop.
      await store.setState(id, decision.state);
      break;
    case 'notice':
      // With the Claude Code process it is given in: a /clear keeps the process, so the fresh tab binds by it.
      await store.setState(id, { ...decision.state, claudePid: claude ?? null });
      break;
    case 'none':
    case 'measure':
      break;
  }
  return decision;
}

/** The model notices for the user at this turn's end (`stopModelNotices`); none without a Claude Code session id. */
async function modelNoticesOf(runtime: CliRuntime, scope: SessionScope, payload: JsonRecord): Promise<readonly string[]> {
  const claude = sessionIdOf(payload);
  if (claude === null) {
    return [];
  }
  const { kit, config, roster, id } = scope;
  return stopModelNotices(runtime.files, new ModelNoticeStore(runtime.files, kit.paths.modelNotices), {
    id,
    name: roster.nameOf(id) ?? id,
    launch: launchOf(config, id),
    claude,
    effort: payloadEffortOf(payload),
    transcript: stringField(payload, 'transcript_path'),
  });
}

/**
 * The one-time ask that sends the session back at this turn's end: for a hired session, to write its handover
 * (last-task-ask.ts), else, while a task of it waits, to work its other tasks (keep-working.ts). None on a stop the
 * hook already blocked, or while the refresh blocks or waits for its restart, so the asks wait for a later stop.
 */
async function askBlockOf(runtime: CliRuntime, scope: SessionScope, payload: JsonRecord, decision: StopDecision): Promise<string | undefined> {
  if (payload['stop_hook_active'] === true || decision.kind === 'block' || decision.kind === 'notice') {
    return undefined;
  }
  return (await lastTaskAskReasonOf(runtime, scope.config, scope.kit.paths, scope.id)) ?? keepWorkingReasonOf(runtime, scope);
}

/**
 * The tab's title at this turn's end with tab status on (hook-tab-status.ts): a circle before the refresh
 * notice's title, else before the session's topic. Undefined with tab status off, which leaves the notice's
 * own title, at a block, whose turn goes on, and on an error.
 */
async function stopTabTitleOf(runtime: CliRuntime, team: TeamScope, roster: Roster | undefined, payload: JsonRecord, decision: StopDecision): Promise<string | undefined> {
  if (!tabStatusOn(runtime.env, team.config) || decision.kind === 'block') {
    return undefined;
  }
  const own = { team: team.kit.paths.team, roster: roster ?? (await rosterOf(runtime, team.kit, team.config)) };
  return tabTitleOf(runtime, payload, own, decision.kind === 'notice' ? decision.title : undefined).catch((): string | undefined => undefined);
}

/**
 * What the Stop hook prints for this turn's end; '' outside a team, and only the tab's title (with tab status
 * on) in a tab that is no session of it. The refresh, the model notices, the budget lines and the verify-by
 * lines fail apart: an error in one leaves the others.
 */
async function stopOutputOf(runtime: CliRuntime, payload: JsonRecord): Promise<string> {
  const team = await teamScopeOf(runtime, payload);
  const scope = team === undefined ? undefined : await sessionScopeOf(runtime, team, payload);
  if (scope === undefined) {
    const none: StopDecision = { kind: 'none' };
    return team === undefined ? '' : stopOutput(none, [], await stopTabTitleOf(runtime, team, undefined, payload, none));
  }
  await logReply(runtime, { config: scope.config, paths: scope.kit.paths, id: scope.id }, payload).catch(() => undefined);
  // Before the refresh, which records a block's state before it prints: this block leaves the rest to the next stop.
  const dropped = await droppedEditReasonOf(runtime, payload, 'main').catch((): string | undefined => undefined);
  if (dropped !== undefined) {
    return blockOutput(dropped);
  }
  const decision = await refreshDecisionOf(runtime, scope, payload).catch((): StopDecision => ({ kind: 'none' }));
  // Before the model notices, which then read the level just written: no "runs at another effort" for a typed /effort.
  const effort = await effortWritebackOf(runtime, scope, payload).catch((): EffortWritebackOutcome => ({ config: scope.config, lines: [] }));
  const notices = await modelNoticesOf(runtime, { ...scope, config: effort.config }, payload).catch((): readonly string[] => []);
  const budget = await stopBudgetLines(runtime, scope, stringField(payload, 'transcript_path')).catch((): readonly string[] => []);
  const verify = await verifyByLinesOf(runtime, scope.kit.paths, scope.id, teamZone(scope.config, runtime)).catch((): readonly string[] => []);
  await startAutoSync(runtime, scope.kit, scope.config).catch(() => undefined);
  const hookless = await checkHooklessTabs(runtime, scope.kit, scope.config).catch((): readonly string[] => []);
  const lead = await leadStopLines(runtime, scope, stringField(payload, 'transcript_path')).catch((): readonly string[] => []);
  const lines = [...effort.lines, ...notices, ...budget, ...verify, ...lead, ...hookless];
  const ask = await askBlockOf(runtime, scope, payload, decision).catch((): string | undefined => undefined);
  if (ask === undefined && decision.kind !== 'block') {
    // Only a turn that ends: a block sends the session on working, which its next tool's end records.
    await recordTabNeed(runtime, payload, scope).catch(() => undefined);
  }
  return ask === undefined ? stopOutput(decision, lines, await stopTabTitleOf(runtime, scope, scope.roster, payload, decision)) : blockOutput(ask, lines);
}

/**
 * Stop, at the end of every turn: first sends the session back, once, to a skill edit of the turn that
 * Claude Code refused and it never redid (hook-dropped-edit.ts), leaving the rest to its next stop. It asks the session for its handover once when its context reached the
 * team's threshold or the lead asked, and at a task end (`set done`) also after enough tasks, then tells the user
 * once that it waits for /clear, or with `refresh.autoRestart` that it restarts by itself when idle (hook-restart.ts). It
 * writes an `/effort` the user typed in the session to its `launch` entry, logs it and tells its leader
 * (hook-effort-writeback.ts). It also tells the user, once each, when the session runs at another
 * effort than its `launch` entry or Claude Code switched its model after a safeguard stop, and once a
 * day when the date to verify one of its verifying tasks by has come. Under `hiring.policy` `automatic` it asks a
 * hired session whose last open task closed, once, to write its handover and retire; after a `set` to waiting it sends the
 * session, once, to its work it can start that does not come after the waiting task (keep-working.ts),
 * never in quiet hours or past its daily budget. Once per `github.everyMinutes` for the whole
 * team it starts `gh sync --auto` hidden in the background (gh-auto.ts), and every 10 minutes it tells the lead of
 * a team tab that runs without its hooks (hook-hookless.ts). With tab status on, it also sets the
 * tab's title to the ready circle, or the working one while a helper runs, in any tab of the team (hook-tab-status.ts).
 * Each team session's reply is logged for the task pane (hook-turn-log.ts).
 * A turn with nothing to say reads only small files and the transcript's tail (and, at the first stop of a UTC day,
 * the register log; with tab status on, the longer tail where helpers start), and prints nothing but the tab's title.
 * It never blocks on an error, and ignores input that is not a hook payload (which would judge a boundary without
 * its transcript): a refresh is a convenience, and the next stop tries again.
 */
export async function stop(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const output = isRecord(payload) ? await stopOutputOf(runtime, payload).catch(() => '') : '';
  if (output !== '') {
    runtime.out.stdout(output);
  }
  return EXIT.ok;
}

/**
 * SessionStart: the core rules from the team config, who the session is (after a refresh, its handover; after a
 * refresh or a compaction, its live tasks), and the team's rules.md. A compaction inside a helper fires it too,
 * under the session's id: that start gets the helper's context (hook-helper-start.ts) and binds, renames and
 * refreshes nothing.
 */
export async function sessionStart(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const found = await sessionTeam(payload, runtime);
  switch (found.kind) {
    case 'none':
      return EXIT.ok;
    case 'broken':
      runtime.out.stdout(sessionStartOutput(`${KIT_NAME}: no team, so no team rules: ${found.from} ${found.problem}`));
      return EXIT.ok;
    case 'team':
      break;
  }
  const kit = await openKit(runtime, found.team);
  const helper = helperOf(payload);
  if (helper !== undefined) {
    // A compaction inside a helper: the helper's rules again, and none of the session's side effects.
    runtime.out.stdout(sessionStartOutput(await helperContextOf(runtime, kit, payload, helper.agentType)));
    return EXIT.ok;
  }
  const parts: TeamParts =
    kit.load.status === 'loaded'
      ? await teamPartsOf(runtime, kit, kit.load.config, payload)
      : {
          recordNote: undefined,
          envBindNote: undefined,
          teamRules: [],
          keptRulesAbove: [],
          renames: [],
          titleNote: undefined,
          refreshNote: undefined,
          liveTasksNote: undefined,
          modelNote: undefined,
          verifyNote: undefined,
          duplicateNote: undefined,
          worktreeNote: undefined,
          session: undefined,
          sessionInEnv: false,
          tree: undefined,
        };
  const context = sessionStartContext({ team: found.team, load: kit.load, ...parts, command: KIT_NAME, platform: runtime.platform, clock: rulesClockOf(runtime) });
  const requirementsNote = await requirementsNoteOnce({
    problems: await runtime.requirements.problems(),
    log: new JsonlHintLog(hookLogOf(runtime, kit.paths, 'bind-hints')),
    claudeSession: sessionIdOf(payload),
    now: new Date(runtime.clock.now()),
    command: KIT_NAME,
  });
  runtime.out.stdout(sessionStartOutput(context, [parts.duplicateNote, parts.modelNote, parts.recordNote, parts.envBindNote, requirementsNote]));
  return EXIT.ok;
}
