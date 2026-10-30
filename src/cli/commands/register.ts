import { LeadTree } from '../../config/lead-tree.ts';
import type { Roster } from '../../config/roster.ts';
import { formatAddress, splitAddress, type SessionAddress } from '../../core/address.ts';
import { errorMessage } from '../../core/guards.ts';
import { KIT_NAME } from '../../core/home.ts';
import type { TimeZone } from '../../core/zone.ts';
import { JsonlDailyLog } from '../../core/daily-log.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { burstsOver } from '../../budget/burst.ts';
import { formatW } from '../../budget/format.ts';
import { timingText, waitTiming, type WaitTiming } from '../../decisions/lines.ts';
import { allowFindings, contextSizeFindings } from '../../doctor/doctor.ts';
import { hireFlags } from '../../hiring/due.ts';
import { HiringLog } from '../../hiring/log.ts';
import { activeHires } from '../../hiring/record.ts';
import { scaleOutFlags } from '../../hiring/scale-out.ts';
import { postLine } from '../../inbox/inbox.ts';
import { formatTaskLines, taskLinesOf } from '../../inbox/task-lines.ts';
import { WakeAsks } from '../../wake/asks.ts';
import { teamDayStartAt } from '../../wake/day-start.ts';
import { waitAnswerersOf } from '../../register/approval.ts';
import { byFlagKind, checkTasks, peerWaitFlags } from '../../register/check.ts';
import { currentWeekOf } from '../../register/week.ts';
import type { ApprovalVerdict, TaskFields } from '../../register/events.ts';
import { fitLines, leftOfWeek, overLimitFlag, weekFit, type WeekFit } from '../../register/fit.ts';
import type { Task } from '../../register/fold.ts';
import { bugHint } from '../../register/bug-hint.ts';
import { reviewGap, reviewGapText } from '../../register/review.ts';
import { renderPlan } from '../../register/plan.ts';
import { noProgressFlag } from '../../register/progress.ts';
import { overSizeFlags } from '../../register/over-size.ts';
import type { AddInput, AskInput, StatusInput, Verdict } from '../../register/policy.ts';
import type { Register, WriteResult } from '../../register/register.ts';
import { ACTIVE_STATUSES, type TaskStatus } from '../../register/model.ts';
import type { RegisterSnapshot, RetiredTasks } from '../../register/snapshot.ts';
import { readStopgapTags, stopgapFlags, stopgapTags } from '../../register/stopgap.ts';
import { dueStartHolds, dueVerifyHold, heldStart, heldStartNotice, metStartNotice, startHolds, verifyQueue, watchQueue, type DueVerify } from '../../register/verify.ts';
import { readAs, TaskTree, type TaskElsewhere } from '../../register/tree.ts';
import { approvalNotice, endedNotice, formatTask, formatTaskDetail, formatTaskTree, formatVerifyRow, formatWatchRow, personWaitNotice, selectTasks, type ListFilter } from '../../register/views.ts';
import { isPeerWait, sameWait, type PersonWait } from '../../register/waits.ts';
import { lintSkills } from '../../skills/lint.ts';
import { SKILL_FILE, SkillDir } from '../../skills/store.ts';
import { weekUseOnAccount } from '../account-teams.ts';
import { readWideAllow, teamSettingsScope } from '../allow-scope.ts';
import { noPositionals, onePositional, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { addInputOf, callerOf, changesOf, criticalOf, deadlineOf, listFilterOf, NONE, pinOf, setInputOf, taskIdOf, taskRefOf, weekOf, type TypedTimes } from '../inputs.ts';
import { findTeam, openKit, pastOrPresentIdOf, projectFolder, sessionIdOf, teamZone } from '../kit.ts';
import { checkLines, listLines, SHORT_TITLE_CHARS, waitingOnLines, type CheckReport, type CheckSection, type LeadDecisions, type TaskRow } from '../reports.ts';
import { idlePassWarnings } from '../idle-pass-check.ts';
import { secretGuardOffWarnings } from '../secret-guard-off-check.ts';
import { secretHookWarnings } from '../secret-hook-check.ts';
import { ownerBatchOf, type BatchedTeam } from '../owner-batch.ts';
import { rollUp, type RolledTeam, type RollUp } from '../roll-up.ts';
import { splitUnowned } from '../unowned.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree, skillOwnersElsewhere, type KitTree, type TreeTeam } from '../tree.ts';
import { readBursts } from '../burst-reading.ts';
import { readScaleOutBudget } from '../hire-cost.ts';
import { readWPerPct } from '../stored-week.ts';
import { readTaskSpend } from '../task-spend.ts';
import { taskFilesLine } from '../task-files.ts';
import { readContextInput } from './doctor.ts';
import { inboxDepsOf } from './inbox.ts';
import { markBoundary } from './refresh.ts';
import { markKeepWorkingAsk } from './keep-working.ts';
import { markLastTaskAsk } from './last-task-ask.ts';
import { openTeam, postNamed, teamOf, tellAssigned, tellLine, type Team } from './register-team.ts';
import { askTeam, treeCallerOf } from './team-ask.ts';

/** What a time the caller types is read against: this moment and the zone of the caller's own team. */
function typedTimes(runtime: CliRuntime, zone: TimeZone): TypedTimes {
  return { nowMs: runtime.clock.now(), zone };
}

/** The owner as an id; a source naming a session becomes its id, the owner's marker or a past session's id stays. */
function addInputIds(team: Team, input: AddInput): AddInput {
  const source = input.source === team.config.register.ownerSource ? input.source : pastOrPresentIdOf(team.roster, input.source);
  return { ...input, owner: sessionIdOf(team.roster, input.owner), source };
}

/**
 * Who a decision or an approval waits for, as an id: a session's name, bare or as `<own team>/<name>`, becomes its id,
 * the owner's marker stays, and another team's `<team>/<id>` stays as typed, for the policy to judge: the parent team's
 * lead approves the lead's own work (T1140).
 */
function statusInputIds(team: Team, input: StatusInput): StatusInput {
  if (input.waits === undefined) {
    return input;
  }
  const { ownerSource } = team.config.register;
  const idOf = (who: string): string => {
    const address = splitAddress(who);
    if (address?.team === undefined) {
      return sessionIdOf(team.roster, who);
    }
    return address.team === team.paths.team ? sessionIdOf(team.roster, address.session) : who;
  };
  const waits = input.waits.map((reason) =>
    (reason.kind === 'decision' || reason.kind === 'approval') && reason.who !== ownerSource ? { kind: reason.kind, who: idOf(reason.who) } : reason,
  );
  return { ...input, waits };
}

function changeIds(roster: Roster, changes: Partial<TaskFields>): Partial<TaskFields> {
  return changes.owner === undefined ? changes : { ...changes, owner: sessionIdOf(roster, changes.owner) };
}

function filterIds(roster: Roster, filter: ListFilter): ListFilter {
  return {
    ...filter,
    ...(filter.owner === undefined ? {} : { owner: pastOrPresentIdOf(roster, filter.owner) }),
    ...(filter.source === undefined ? {} : { source: pastOrPresentIdOf(roster, filter.source) }),
  };
}

/** How a line about automatic archiving names its switch: the key, and the config file that holds it. */
function autoArchiveSwitch(configPath: string): string {
  return `turn automatic archiving off with register.autoArchive: false in ${configPath}`;
}

/**
 * The written task's line, its times in the zone of `written`, the team whose register was written; `label` names
 * another team's register, so its id reads `<label>/T12`. A rotation the write ran is named on stderr, so the task
 * line stays the one line a script reads, with the switch that turns it off in the written team's config.
 */
function report(runtime: CliRuntime, verdict: Verdict<WriteResult>, verb: string, written: Pick<Team, 'paths' | 'zone'>, label?: string): ExitCode {
  if (!verdict.ok) {
    throw new RefusedError(verdict.error);
  }
  const { task, state, elsewhere } = verdict.value;
  runtime.out.stdout(`${verb} ${formatTask(task, label, new TaskTree(state.tasks, new Date(runtime.clock.now()), written.zone, undefined, elsewhere))}`);
  const { rotation } = verdict.value;
  const turnOff = autoArchiveSwitch(written.paths.config);
  if (rotation.kind === 'rotated') {
    runtime.out.stderr(`NOTE the task list's log is archived as segment ${rotation.segment}; ${rotation.retired} finished task(s) left the working set (${turnOff})`);
  } else if (rotation.kind === 'failed') {
    runtime.out.stderr(`WARN the write is saved, but archiving the task list's log failed (the next write tries again; ${turnOff}): ${rotation.error}`);
  }
  return EXIT.ok;
}

/** Damaged or newer lines never stop a read; they are named on stderr so someone fixes them. */
export function warnDamage(runtime: CliRuntime, snapshot: RegisterSnapshot, path: string): void {
  const { unreadable, newer } = snapshot.read;
  const { orphans } = snapshot.state;
  if (unreadable + newer + orphans > 0) {
    runtime.out.stderr(
      `WARN ${path}: ${unreadable} unreadable line(s), ${newer} line(s) from a newer teamrig, ${orphans} event(s) naming no task`,
    );
  }
}

/**
 * `add --team <team>`: a session asks another team of its tree for work (askTeam), owned by `--owner` (a session of
 * that team, by name or id), else by that team's lead. `--team` naming the caller's own team is a plain add.
 */
async function addToTeam(args: ParsedArgs, runtime: CliRuntime, caller: string, asked: string): Promise<ExitCode> {
  const { team } = await findTeam(runtime);
  if (asked === team) {
    return addHere(args, runtime, caller);
  }
  if (args.flags.has('source')) {
    throw new UsageError("--team adds the task from you: it takes no --source, unless it names your own team");
  }
  const from = await treeCallerOf(runtime, team, caller, asked);
  const input = { ...addInputOf(args.flags, caller, typedTimes(runtime, teamZone(from.config, runtime))), ...criticalOf(args.switches) };
  const { verdict, target } = await askTeam(runtime, from, { asked, owner: args.flags.get('owner') }, input);
  return report(runtime, verdict, 'ADDED', target, asked);
}

export async function add(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const caller = callerOf(args.flags, runtime.env);
  const asked = args.flags.get('team');
  return asked === undefined ? addHere(args, runtime, caller) : addToTeam(args, runtime, caller, asked);
}

/** A task of the caller's own team, owned by `--owner`, else by the caller. */
async function addHere(args: ParsedArgs, runtime: CliRuntime, caller: string): Promise<ExitCode> {
  const team = await openTeam(runtime, 'write');
  const input = { ...addInputOf(args.flags, caller, typedTimes(runtime, team.zone)), ...criticalOf(args.switches) };
  const by = sessionIdOf(team.roster, caller);
  const verdict = await team.register.add(by, addInputIds(team, input));
  const code = report(runtime, verdict, 'ADDED', team);
  if (verdict.ok) {
    noteBugHint(runtime, team, verdict.value.task);
  }
  await tellNewOwner(runtime, team, by, verdict);
  return code;
}

/** A NOTE asking to mark the task a bug when its text reads like one and no one gave it a type (register/bug-hint.ts). */
function noteBugHint(runtime: CliRuntime, team: Team, task: Task): void {
  const hint = bugHint(task, team.config.register.review.hintPattern);
  if (hint !== undefined) {
    runtime.out.stderr(`NOTE ${hint}`);
  }
}

/**
 * A WARN naming the review parts a bug reached `status` without, while `register.review.mode` is `warn`
 * (refuse never writes it, and off asks nothing); judged on the task as written, so its review holds every part given.
 */
function warnReviewGap(runtime: CliRuntime, team: Team, task: Task, status: TaskStatus): void {
  const { review } = team.config.register;
  const missing = review.mode === 'warn' ? reviewGap(task, status, {}, review) : [];
  if (missing.length > 0) {
    runtime.out.stderr(`WARN ${reviewGapText(task, status, missing)}; set anyway, as register.review.mode is warn`);
  }
}

/**
 * One inbox line to the task's owner when this write gave it the task (`add --owner`, `update --owner`), so asking
 * for work is one command; never to the caller, who gave it. A line that cannot be posted is named, never thrown:
 * the task is written either way.
 */
async function tellNewOwner(runtime: CliRuntime, team: Team, by: string, verdict: Verdict<WriteResult>): Promise<void> {
  if (!verdict.ok) {
    return;
  }
  const { task, before } = verdict.value;
  if (task.owner === by || task.owner === before?.owner) {
    return;
  }
  await tellAssigned(runtime, team, by, task);
}

/**
 * One inbox line to each leader that a write set a task waiting on, or a verifying task's proof, for a decision or an
 * approval it did not wait on before: a wait on one of the task owner's leaders (the lead, or a sub-lead, T781) goes
 * to that leader, a wait on the owner to the task owner's own leader, which passes it up (the lead keeps the owner's
 * decision queue and asks it in its batch); never to the leader who set it. A wait on the parent team's lead, the
 * lead's own approver on a child team (T1140), goes to that lead's inbox in the parent team, the task named
 * `<team>/T12`, and so does a child team's lead's own wait on the owner (T1265), as that lead is its leader. A new
 * wait on the owner says when the owner hears it (src/decisions/batch.ts): in the next batch, in the one due now, or
 * at once when it is due before the next. At once, the lead who asks the owner is woken, or the setter told how to
 * reach it: the team's lead (atOnceNote), or, for a child team, the lead at its tree's root (atOnceAtRoot, T1277).
 */
async function tellLeadersOfWaits(runtime: CliRuntime, team: Team, by: string, verdict: Verdict<WriteResult>): Promise<void> {
  if (!verdict.ok) {
    return;
  }
  const { lead } = team.config.roles;
  const { ownerSource } = team.config.register;
  const { task, before } = verdict.value;
  const earlier = before?.waits ?? [];
  const leaders = new LeadTree(team.config, team.above);
  const answerers = waitAnswerersOf(leaders, team.config.roles, task.owner);
  const added = task.waits.filter(
    (reason): reason is PersonWait =>
      (reason.kind === 'decision' || reason.kind === 'approval') && !isPeerWait(reason, answerers, ownerSource) && !earlier.some((other) => sameWait(reason, other)),
  );
  const ownLeader = leaders.leaderOf(task.owner) ?? leaders.above ?? lead;
  const receiverOf = (reason: PersonWait) => (reason.who === ownerSource ? ownLeader : reason.who);
  const addressed = { ...task, id: `${team.paths.team}/${task.id}` };
  for (const receiver of new Set(added.map(receiverOf))) {
    if (receiver === by) {
      continue;
    }
    const waits = added.filter((reason) => receiverOf(reason) === receiver);
    const owner = waits.some((reason) => reason.who === ownerSource) ? await ownerWaitOf(runtime, team, verdict.value) : undefined;
    const when = owner === undefined ? '' : ` | ${timingText(owner.timing, team.zone)}`;
    const crossing = receiver === leaders.above;
    const text = `${personWaitNotice(crossing ? addressed : task, waits, receiver)}${when}`;
    const posted = crossing ? await tellLeadAbove(runtime, team, by, receiver, text) : await tellLine(runtime, team, by, receiver, text, `${receiver} was not told that ${task.id} waits on it`);
    if (owner?.timing.kind !== 'at-once') {
      continue;
    }
    const root = owner.askedBy;
    if (root === undefined) {
      runtime.out.stderr(await atOnceNote(runtime, team, by, task.id, receiver, posted ? text : undefined));
      continue;
    }
    const lined = receiver === formatAddress(root.address);
    const rootText = lined ? text : `${personWaitNotice(addressed, waits.filter((reason) => reason.who === ownerSource), formatAddress(root.address))}${when}`;
    const told = lined ? posted : await tellAcross(runtime, team, by, root, rootText);
    runtime.out.stderr(await atOnceAtRoot(runtime, team, by, task.id, root, told ? rootText : undefined));
  }
}

/** A session of another team of the tree, and its team as the tree loaded it. */
interface TreeSession {
  readonly address: SessionAddress;
  readonly home: TreeTeam;
}

/** The parent team's lead (`<team>/<id>`, T1140), who gets its line in its own team's inbox (tellAcross). */
async function tellLeadAbove(runtime: CliRuntime, team: Team, by: string, above: string, text: string): Promise<boolean> {
  const address = splitAddress(above);
  const aboveTeam = address?.team;
  const home = aboveTeam === undefined ? undefined : (await loadTree(runtime)).teams.get(aboveTeam);
  if (address === undefined || aboveTeam === undefined || home === undefined) {
    runtime.out.stderr(`WARN ${above} was not told of the wait on it: its team has no config in this kit home`);
    return false;
  }
  return tellAcross(runtime, team, by, { address: { team: aboveTeam, id: address.session }, home }, text);
}

/**
 * One inbox line to a session of another team of the tree in its own team's inbox, from `<team>/<setter>`, scanned
 * with both teams' secret patterns, as tellAskerOfEnd posts across teams. A line that cannot be posted is named,
 * never thrown.
 */
async function tellAcross(runtime: CliRuntime, team: Team, by: string, to: TreeSession, text: string): Promise<boolean> {
  const shown = formatAddress(to.address);
  const secrets = new SecretScanner([...team.config.register.secretPatterns, ...to.home.config.register.secretPatterns]);
  const from = formatAddress({ team: team.paths.team, id: by });
  return postNamed(runtime, to.home.kit.paths, secrets, { to: to.address.id, from, text }, `${shown} was not told of the wait on it`, shown);
}

/**
 * What the setter of a child team's owner wait due before the next batch is told (T1277). The lead at its tree's root
 * asks the owner, and the setter cannot `--wake now` it, so that lead's line, `posted` (its own, or the receiver's
 * when the line went to it; undefined when it could not be posted), gets a wake ask in its own team's folder, as an
 * `inbox add --wake now` line across teams does; the leads between keep their line, unwoken. With the root team's
 * wakes off, or a line or an ask that cannot be posted, the setter is told to message that lead.
 */
async function atOnceAtRoot(runtime: CliRuntime, team: Team, by: string, id: string, root: TreeSession, posted: string | undefined): Promise<string> {
  const name = root.home.roster.nameOf(root.address.id) ?? formatAddress(root.address);
  const due = `${id} is due before the owner's next batch`;
  const message = `message ${name}, who asks the owner`;
  if (!root.home.config.wake.enabled) {
    return `NOTE ${due}: ${message}, as an inbox line wakes no one`;
  }
  if (posted === undefined) {
    return `NOTE ${due}: ${message}, as its line could not be posted`;
  }
  try {
    const from = formatAddress({ team: team.paths.team, id: by });
    await new WakeAsks(runtime.files, root.home.kit.paths.wakeAsks).post(root.address.id, { from, text: posted, at: runtime.clock.now() });
  } catch (error) {
    return `WARN ${due}, and ${name}'s wake could not be asked (${errorMessage(error)}): ${message}`;
  }
  return `NOTE ${due}: its line wakes ${name}, who asks the owner, so no message is needed`;
}

/**
 * What the setter of an owner wait due before the next batch is told, so the lead hears of it at once. With wakes on,
 * the lead's own posted line also gets a wake ask, as an `inbox add --wake now` line does; a line that went to a
 * sub-lead, or was not posted, leaves the setter the wake line to post the lead. With wakes off a line wakes no one,
 * so the setter messages the lead.
 */
async function atOnceNote(runtime: CliRuntime, team: Team, by: string, id: string, receiver: string, posted: string | undefined): Promise<string> {
  const { lead } = team.config.roles;
  const leadName = team.roster.nameOf(lead) ?? lead;
  const due = `${id} is due before the owner's next batch`;
  if (!team.config.wake.enabled) {
    const how = receiver === lead ? ' too, as an inbox line wakes no one' : `, who asks the owner: the inbox line went to ${receiver}, and a line wakes no one`;
    return `NOTE ${due}: message ${leadName}${how}`;
  }
  const wakeLine = `${KIT_NAME} inbox add --to ${lead} --text "..." --wake now`;
  if (receiver !== lead) {
    return `NOTE ${due}: wake ${leadName}, who asks the owner (the inbox line went to ${receiver}): ${wakeLine}`;
  }
  if (posted === undefined) {
    return `NOTE ${due}: wake ${leadName}: ${wakeLine}`;
  }
  try {
    await new WakeAsks(runtime.files, team.paths.wakeAsks).post(lead, { from: by, text: posted, at: runtime.clock.now() });
  } catch (error) {
    return `WARN ${due}, and ${leadName}'s wake could not be asked (${errorMessage(error)}): ${wakeLine}`;
  }
  return `NOTE ${due}: its line wakes ${leadName}, so no message is needed`;
}

/** When the owner hears of a task's new wait on them, and, for a child team, the lead at its tree's root, who asks them. */
interface OwnerWait {
  readonly timing: WaitTiming;
  readonly askedBy: TreeSession | undefined;
}

/**
 * When the owner hears of a task's new wait on them, judged on the register after the write, in the batch that holds
 * the team's waits: a child team's is the one the lead at its tree's root asks (ownerBatchOf). That lead's team is the
 * tree's, as the tree is built from the teams it loaded.
 */
async function ownerWaitOf(runtime: CliRuntime, team: Team, { task, state, elsewhere }: WriteResult): Promise<OwnerWait> {
  const now = runtime.clock.now();
  const own: BatchedTeam = { team: team.paths.team, config: team.config, paths: team.paths, tasks: state.tasks, elsewhere };
  const loaded = await loadTree(runtime);
  const { batch, askedBy } = await ownerBatchOf(runtime, own, loaded, now);
  const home = askedBy === undefined ? undefined : loaded.teams.get(askedBy.team);
  const timing = waitTiming(batch, task, new TaskTree(state.tasks, new Date(now), team.zone, undefined, elsewhere), now);
  return { timing, askedBy: askedBy === undefined || home === undefined ? undefined : { address: askedBy, home } };
}

/**
 * One inbox line to the session that asked this team for a task (`add --team`, its source `<team>/<id>`) when the
 * task ends, done or dropped (T509, T1141): the asker's register holds no copy of it, so the line is how it hears. It
 * goes to the asker, or to its team's lead when the asker has left that team, under `<team>/<setter>`, scanned with
 * both teams' secret patterns; a task of the team's own tells no one. A line that cannot be posted is named, never thrown.
 */
async function tellAskerOfEnd(runtime: CliRuntime, team: Team, by: string, verdict: Verdict<WriteResult>): Promise<void> {
  if (!verdict.ok) {
    return;
  }
  const here = team.paths.team;
  const { task, before } = verdict.value;
  const asker = splitAddress(task.source);
  if (ACTIVE_STATUSES.includes(task.status) || before?.status === task.status || asker?.team === undefined || asker.team === here) {
    return;
  }
  const ended = `${here}/${task.id} ended`;
  const home = (await loadTree(runtime)).teams.get(asker.team);
  if (home === undefined) {
    runtime.out.stderr(`WARN ${task.source} was not told that ${ended}: team ${asker.team} has no config in this kit home`);
    return;
  }
  const to = home.config.sessions.includes(asker.session) ? asker.session : home.config.roles.lead;
  const shown = formatAddress({ team: asker.team, id: to });
  const secrets = new SecretScanner([...team.config.register.secretPatterns, ...home.config.register.secretPatterns]);
  await postNamed(runtime, home.kit.paths, secrets, { to, from: formatAddress({ team: here, id: by }), text: endedNotice(task, here) }, `${shown} was not told that ${ended}`, shown);
}

export async function set(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = taskIdOf(onePositional(args, 'id'));
  const caller = callerOf(args.flags, runtime.env);
  const team = await openTeam(runtime, 'write');
  const typed = setInputOf(args.flags, typedTimes(runtime, team.zone));
  const { config, paths, register, roster } = team;
  const by = sessionIdOf(roster, caller);
  const input = statusInputIds(team, typed.status);
  if (typed.ask !== null) {
    return setAsking(runtime, team, by, id, { ...typed.ask, owner: sessionIdOf(roster, typed.ask.owner) }, input);
  }
  const { held, due } = await startGatesOf(register, by, id, input, new Date(runtime.clock.now()), team.zone, config.register.maxVerifying);
  const verdict = await register.setStatus(by, id, input);
  const warned = config.register.verifyGate === 'warn';
  // The start as written: one that named its held proof as met asks the verifying owners to confirm it.
  const met = verdict.ok && verdict.value.event.type === 'status' ? (verdict.value.event.met ?? null) : null;
  if (held !== undefined && (verdict.ok || !warned)) {
    await tellVerifiers(runtime, team, by, held, met);
  }
  const exit = report(runtime, verdict, 'SET', team);
  if (verdict.ok && input.status === 'in-progress' && verdict.value.before?.status !== 'in-progress') {
    noteBugHint(runtime, team, verdict.value.task);
  }
  await tellLeadersOfWaits(runtime, team, by, verdict);
  await tellAskerOfEnd(runtime, team, by, verdict);
  if (held !== undefined && warned && verdict.ok && met === null) {
    runtime.out.stderr(`WARN ${heldStart(held.task, held.holds)}; started anyway, as register.verifyGate is warn`);
  }
  if (due !== undefined && warned && verdict.ok) {
    runtime.out.stderr(`WARN ${dueVerifyHold(due.task, due.due)}; started anyway, as register.verifyGate is warn`);
  }
  if (verdict.ok) {
    warnReviewGap(runtime, team, verdict.value.task, input.status);
  }
  if (input.status === 'done') {
    await markBoundary(runtime, config, paths, by, id);
  }
  if (verdict.ok && (input.status === 'done' || input.status === 'dropped')) {
    await markLastTaskAsk(runtime, config, paths, verdict.value);
  }
  if (verdict.ok && input.status === 'waiting') {
    await markKeepWorkingAsk(runtime, paths, verdict.value);
  }
  return exit;
}

/**
 * `set --ask`: the asked task and the wait on it in one write, its line printed above the `SET` line; the asked
 * session hears its task is its own (unless the caller asked itself), and the lead hears of a wait on it or the owner.
 * The caller's task now waits, so its next stop sends it to its other work (keep-working.ts).
 */
async function setAsking(runtime: CliRuntime, team: Team, by: string, id: string, ask: AskInput, input: StatusInput): Promise<ExitCode> {
  const verdict = await team.register.ask(by, id, ask, input);
  if (verdict.ok) {
    const { asked, state, elsewhere } = verdict.value;
    runtime.out.stdout(`ADDED ${formatTask(asked, undefined, new TaskTree(state.tasks, new Date(runtime.clock.now()), team.zone, undefined, elsewhere))}`);
  }
  const exit = report(runtime, verdict, 'SET', team);
  if (verdict.ok && verdict.value.asked.owner !== by) {
    await tellAssigned(runtime, team, by, verdict.value.asked);
  }
  await tellLeadersOfWaits(runtime, team, by, verdict);
  if (verdict.ok) {
    await markKeepWorkingAsk(runtime, team.paths, verdict.value);
  }
  return exit;
}

/** A start the verifying tasks it needs hold: the task, as the caller's own, and those tasks. */
interface HeldStart {
  readonly task: Task;
  readonly holds: readonly Task[];
}

/** A first start its owner's own due verify steps hold: the task, as the caller's own, and those steps. */
interface DueStart {
  readonly task: Task;
  readonly due: readonly DueVerify[];
}

/** What holds the caller's start of its own task: the verifying tasks it needs, and its owner's due verify steps. */
interface StartGates {
  readonly held: HeldStart | undefined;
  readonly due: DueStart | undefined;
}

const OPEN_START: StartGates = { held: undefined, due: undefined };

/**
 * What holds the caller's start of its own task, read before the write: the policy refuses that start (or lets
 * it through in warn mode); the owners of the verifying tasks it needs hear of it either way.
 */
async function startGatesOf(register: Register, caller: string, id: string, input: StatusInput, now: Date, zone: TimeZone, maxVerifying: number): Promise<StartGates> {
  if (input.status !== 'in-progress') {
    return OPEN_START;
  }
  const { tasks } = (await register.snapshot()).state;
  const task = tasks.get(id);
  if (task === undefined || task.owner !== caller) {
    return OPEN_START;
  }
  const holds = startHolds(task, input.status, tasks);
  const due = dueStartHolds(task, input.status, tasks, now, zone, maxVerifying);
  return { held: holds.length === 0 ? undefined : { task, holds }, due: due.length === 0 ? undefined : { task, due } };
}

/**
 * One inbox line to the owner of each verifying task that holds a start, once per task pair and UTC
 * day, never to the caller, who reads the refusal: that the start waits, or, for a start that went
 * through with `--met`, what met the proof, to confirm or reopen. A line that cannot be posted is named, never thrown.
 */
async function tellVerifiers(runtime: CliRuntime, team: Team, caller: string, { task, holds }: HeldStart, met: string | null): Promise<void> {
  const now = new Date(runtime.clock.now());
  const told = new JsonlDailyLog(runtime.files, team.paths.verifyNotices);
  const { inboxes } = inboxDepsOf(runtime, team.paths);
  const secrets = new SecretScanner(team.config.register.secretPatterns);
  for (const held of holds) {
    const key = `${met === null ? 'held' : 'met'} ${task.id} on ${held.id}`;
    if (held.owner === caller || (await told.seen(key, now))) {
      continue;
    }
    const text = met === null ? heldStartNotice(task, held) : metStartNotice(task, held, met);
    const problem = await postLine(inboxes, secrets, { to: held.owner, from: caller, text, now });
    if (problem === undefined) {
      await told.record(key, now);
      runtime.out.stderr(`NOTE ${held.owner} has an inbox line: ${text}`);
    } else {
      runtime.out.stderr(`WARN ${held.owner} was not told of ${task.id}: ${problem}`);
    }
  }
}

/** `update <id> --later <when|none> --note ".."`: the owner puts a card off to a time, or `none` brings it back (T1295). */
const LATER_FLAG = 'later';

/**
 * The time `--later` puts a card off to, as stored, null for `none`, or undefined when the flag is not given. A Later
 * changes no field, so it goes with a --note (what the owner said) alone.
 */
function laterOf(args: ParsedArgs, times: TypedTimes): string | null | undefined {
  const value = args.flags.get(LATER_FLAG);
  if (value === undefined) {
    return undefined;
  }
  const others = [...[...args.flags.keys()].filter((flag) => flag !== 'session' && flag !== 'note' && flag !== LATER_FLAG), ...args.switches];
  if (others.length > 0) {
    throw new UsageError(`--later puts a card off with a --note alone: it takes no --${others.join(', --')}`);
  }
  requiredFlag(args.flags, 'note');
  return value === NONE ? null : deadlineOf(`--${LATER_FLAG}`, value, times);
}

/**
 * `update <team>/<id> --note ".." [--later <when|none>]`: the lead who asks the owner a team's decisions, at its tree's
 * root (T1018), records a note, such as the owner's answer, or a Later (T1295) on a task of that team. It lands in that
 * team's register as an event by the lead's `<team>/<id>`. Only that lead may, and only a note or a Later: every field
 * stays the task's own team's to change.
 */
async function noteBelow(args: ParsedArgs, runtime: CliRuntime, caller: string, below: string, id: string): Promise<ExitCode> {
  const others = [...[...args.flags.keys()].filter((flag) => flag !== 'session' && flag !== 'note' && flag !== LATER_FLAG), ...args.switches];
  if (others.length > 0) {
    throw new UsageError(`update ${below}/${id} adds a --note or a --later to another team's task: it takes no --${others.join(', --')}`);
  }
  const note = requiredFlag(args.flags, 'note');
  const { team } = await findTeam(runtime);
  if (team === below) {
    throw new UsageError(`${below}/${id} is a task of your own team: update ${id}`);
  }
  const { from, tree } = await treeCallerOf(runtime, team, caller, below);
  const asker = tree.ownerLeadAbove(below);
  if (asker === undefined) {
    throw new RefusedError(`team ${below} has no parent team, so only its own sessions note its tasks`);
  }
  if (asker.team !== from.team || asker.id !== from.id) {
    throw new RefusedError(`only ${formatAddress(asker)}, who asks the owner team ${below}'s decisions, notes its tasks from another team; ${formatAddress(from)} may not`);
  }
  const target = await teamOf(runtime, await openKit(runtime, below), 'write');
  const later = laterOf(args, typedTimes(runtime, target.zone));
  const by = formatAddress(from);
  const written = later === undefined ? await target.register.noteFrom(by, id, note) : await target.register.deferFrom(by, id, later, note);
  return report(runtime, written, 'UPDATED', target, below);
}

export async function update(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const ref = taskRefOf(onePositional(args, 'id'));
  const caller = callerOf(args.flags, runtime.env);
  if (ref.team !== undefined) {
    return noteBelow(args, runtime, caller, ref.team, ref.id);
  }
  const { id } = ref;
  const team = await openTeam(runtime, 'write');
  const by = sessionIdOf(team.roster, caller);
  const later = laterOf(args, typedTimes(runtime, team.zone));
  if (later !== undefined) {
    return report(runtime, await team.register.defer(by, id, later, args.flags.get('note')), 'UPDATED', team);
  }
  const changes = { ...changesOf(args.flags, typedTimes(runtime, team.zone)), ...criticalOf(args.switches), ...pinOf(args.switches, by) };
  const verdict = await team.register.update(by, id, changeIds(team.roster, changes), args.flags.get('note'));
  const code = report(runtime, verdict, 'UPDATED', team);
  await tellNewOwner(runtime, team, by, verdict);
  return code;
}

/**
 * `approve <team>/<id> --note ".." [--decline]`: the parent team's lead answers an approval wait of team `below`'s
 * lead (T1140). It lands in that team's register as an event by the caller's `<team>/<id>`; only the lead of the team
 * just above `below` may, and the policy still holds it to a task of `below`'s lead waiting on it. The task's owner
 * gets the answer as an inbox line from that address.
 */
async function approveBelow(args: ParsedArgs, runtime: CliRuntime, caller: string, below: string, id: string): Promise<ExitCode> {
  const note = args.flags.get('note');
  const { team } = await findTeam(runtime);
  if (team === below) {
    throw new UsageError(`${below}/${id} is a task of your own team: approve ${id}`);
  }
  const { from: address, tree } = await treeCallerOf(runtime, team, caller, below);
  const from = formatAddress(address);
  const parentLead = tree.parentLeadOf(below);
  if (parentLead === undefined) {
    throw new RefusedError(`team ${below} has no parent team, so only its own leaders approve its tasks`);
  }
  if (formatAddress(parentLead) !== from) {
    throw new RefusedError(`only ${formatAddress(parentLead)}, the lead of team ${below}'s parent, approves its tasks from another team; ${from} may not`);
  }
  const target = await teamOf(runtime, await openKit(runtime, below), 'write');
  const verdict: ApprovalVerdict = args.switches.has('decline') ? 'declined' : 'approved';
  const written = await target.register.approveFrom(from, id, verdict, note);
  const code = report(runtime, written, verdict.toUpperCase(), target, below);
  const answered = written.ok ? written.value.task : null;
  if (answered !== null && answered.answer !== null) {
    const shown = formatAddress({ team: below, id: answered.owner });
    await tellLine(runtime, target, from, answered.owner, approvalNotice({ id: `${below}/${answered.id}` }, answered.answer), `${shown} was not told of the answer on ${below}/${answered.id}`, shown);
  }
  return code;
}

/**
 * `approve <id> --note ".." [--decline]`: the lead's answer to a task waiting on its approval (T684); the task's owner
 * gets one inbox line with the answer and the note, and pushes or merges (or fixes what the note names) at once.
 * `<team>/<id>` answers a child team's lead from the parent team (approveBelow).
 */
export async function approve(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const ref = taskRefOf(onePositional(args, 'id'));
  const caller = callerOf(args.flags, runtime.env);
  if (ref.team !== undefined) {
    return approveBelow(args, runtime, caller, ref.team, ref.id);
  }
  const { id } = ref;
  const team = await openTeam(runtime, 'write');
  const by = sessionIdOf(team.roster, caller);
  const verdict: ApprovalVerdict = args.switches.has('decline') ? 'declined' : 'approved';
  const written = await team.register.approve(by, id, verdict, args.flags.get('note'));
  const code = report(runtime, written, verdict.toUpperCase(), team);
  if (written.ok) {
    const { task } = written.value;
    if (task.answer !== null && task.owner !== by) {
      await tellLine(runtime, team, by, task.owner, approvalNotice(task, task.answer), `${task.owner} was not told of the answer on ${task.id}`);
    }
  }
  return code;
}

/** A filter for one team of a roll-up: a source that names one of its sessions becomes its id. */
function treeFilterOf(roster: Roster, filter: ListFilter): ListFilter {
  const found = filter.source === undefined ? undefined : roster.lookup(filter.source);
  return found?.ok === true ? { ...filter, source: found.id } : filter;
}

/** The caller's own register, as a roll-up of one team. */
export async function ownRegister(runtime: CliRuntime): Promise<RollUp> {
  const { config, paths, roster, register, above } = await openTeam(runtime, 'read');
  const [snapshot, elsewhere] = await Promise.all([register.snapshot(), register.elsewhere()]);
  const own: RolledTeam = { team: paths.team, config, paths, roster, snapshot, history: () => register.history(), elsewhere, above };
  return { own, teams: [own] };
}

/** The registers a command reads: those of `--tree`, else the caller's own. */
async function readRegisters(args: ParsedArgs, runtime: CliRuntime): Promise<RollUp> {
  return args.switches.has('tree') ? rollUp(runtime, callerOf(args.flags, runtime.env)) : ownRegister(runtime);
}

/**
 * True when the working set may lack a task a command shows: only then does it read the whole history.
 * `retired` is what a compaction left in the archive (snapshot.ts).
 */
type HistoryNeed = (retired: RetiredTasks, working: RegisterSnapshot) => boolean;

/** Each register as the command needs it, each naming its damaged lines once, as read. */
async function settle(runtime: CliRuntime, { own, teams }: RollUp, needsHistory: HistoryNeed): Promise<RollUp> {
  const settled: RolledTeam[] = [];
  for (const rolled of teams) {
    const { retired } = rolled.snapshot;
    const snapshot = retired !== null && needsHistory(retired, rolled.snapshot) ? await rolled.history() : rolled.snapshot;
    warnDamage(runtime, snapshot, rolled.paths.events);
    settled.push({ ...rolled, snapshot });
  }
  return { own: settled.find((rolled) => rolled.team === own.team) ?? own, teams: settled };
}

/** The dependency tree of one team's register read now, in its zone and week plan in force: ready wait reasons, effective dues and what needs each task. */
export function taskTreeOf({ snapshot, config, elsewhere }: Pick<RolledTeam, 'snapshot' | 'config' | 'elsewhere'>, runtime: CliRuntime): TaskTree {
  const now = new Date(runtime.clock.now());
  const zone = teamZone(config, runtime);
  return new TaskTree(snapshot.state.tasks, now, zone, currentWeekOf(snapshot, now, zone), elsewhere);
}

/** A filter that selects finished tasks, the only ones a compaction retires. */
function selectsFinished(filter: ListFilter): HistoryNeed {
  return () => (filter.statuses ?? ACTIVE_STATUSES).some((status) => !ACTIVE_STATUSES.includes(status));
}

/** A week plan no newer than the newest one among the retired tasks may name some of them. */
function weekMayBeRetired(week: string): HistoryNeed {
  return (retired) => retired.lastWeek !== null && week <= retired.lastWeek;
}

/**
 * `list --tree`: the lead's team and every team under it, ids read `<team>/T12`. As in `check` and
 * `plan`, `--session` (else `$TEAMRIG_SESSION`) names the caller, never an owner to filter: each team
 * has its own sessions, so a roll-up has no one owner. A setup tab, which has no `$TEAMRIG_SESSION`,
 * reads its tree this way.
 */
async function treeRows(args: ParsedArgs, runtime: CliRuntime): Promise<TaskRow[]> {
  const up = await rollUp(runtime, callerOf(args.flags, runtime.env));
  const filter = listFilterOf(new Map([...args.flags].filter(([name]) => name !== 'session')), typedTimes(runtime, teamZone(up.own.config, runtime)));
  const { teams } = await settle(runtime, up, selectsFinished(filter));
  return teams.flatMap((rolled) => {
    const { team, roster, snapshot } = rolled;
    const tree = taskTreeOf(rolled, runtime);
    return selectTasks(snapshot.state.tasks.values(), treeFilterOf(roster, filter), tree).map((task) => ({ task, team, tree }));
  });
}

async function ownRows(args: ParsedArgs, runtime: CliRuntime): Promise<TaskRow[]> {
  const up = await ownRegister(runtime);
  const filter = listFilterOf(args.flags, typedTimes(runtime, teamZone(up.own.config, runtime)));
  const { own } = await settle(runtime, up, selectsFinished(filter));
  const tree = taskTreeOf(own, runtime);
  return selectTasks(own.snapshot.state.tasks.values(), filterIds(own.roster, filter), tree).map((task) => ({ task, team: undefined, tree }));
}

/** `list [--tree] [--all]`: the short form (src/cli/reports.ts), or with `--all` every field of every task. */
export async function list(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const rows = args.switches.has('tree') ? await treeRows(args, runtime) : await ownRows(args, runtime);
  listLines(rows, args.switches.has('all')).forEach((line) => runtime.out.stdout(line));
  return EXIT.ok;
}

/**
 * `show <id> [--tree]`: every field of the task, its history, its files ({@link taskFilesLine}, T1457) and the team's
 * inbox lines that name it (T1196); with `--tree`, its line, then what it needs and what needs it, each node with its
 * owner, status and due, then who moves next (views.ts formatTaskTree). A task another register of the team tree
 * holds shows read-only ({@link elsewhereLines}), with its files in that team.
 */
export async function show(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = taskIdOf(onePositional(args, 'id'));
  const { own } = await settle(runtime, await ownRegister(runtime), (_retired, working) => !working.state.tasks.has(id));
  const { snapshot } = own;
  const task = snapshot.state.tasks.get(id);
  if (task === undefined) {
    const away = own.elsewhere.get(id);
    if (away === undefined) {
      throw new RefusedError(`no task ${id}`);
    }
    elsewhereLines(away, own, args.switches.has('tree'), runtime).forEach((line) => runtime.out.stdout(line));
    if (!args.switches.has('tree')) {
      runtime.out.stdout(await taskFilesLine(runtime, own.paths.kitHome, away.team, id));
    }
    return EXIT.ok;
  }
  const tree = taskTreeOf(own, runtime);
  if (args.switches.has('tree')) {
    [formatTask(task, undefined, tree), ...formatTaskTree(task, tree, SHORT_TITLE_CHARS)].forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
  }
  const events = snapshot.read.events.filter((event) => event.id === id);
  const wPerPct = task.size === null ? undefined : await readWPerPct(runtime, own.paths, own.config, runtime.clock.now());
  const sizeCost = (pct: number) => (wPerPct === undefined ? undefined : `about ${formatW(pct * wPerPct)} W`);
  const files = await taskFilesLine(runtime, own.paths.kitHome, own.team, id);
  runtime.out.stdout(formatTaskDetail(task, events, tree, { sizeCost, files }));
  const named = await taskLinesOf(inboxDepsOf(runtime, own.paths).inboxes, id);
  formatTaskLines(id, named, tree.zone).forEach((line) => runtime.out.stdout(line));
  return EXIT.ok;
}

/**
 * `show` of a task another register of the team tree holds (T1139): its row, named by its team and judged as that
 * team's sessions judge it (register/tree.ts readAs), then a line saying only they change it; with `--tree`, what it
 * needs and what needs it in that register. Its history stays there.
 */
function elsewhereLines({ team, task }: TaskElsewhere, own: RolledTeam, withTree: boolean, runtime: CliRuntime): string[] {
  const read = readAs(team, own.team, own.snapshot.state.tasks.values(), own.elsewhere);
  const tree = new TaskTree(read.tasks, new Date(runtime.clock.now()), teamZone(own.config, runtime), undefined, read.elsewhere);
  return [
    formatTask(task, team, tree),
    `HELD by team ${team}: only a session of team ${team} changes it, and its history is in that team's register`,
    ...(withTree ? formatTaskTree(task, tree, SHORT_TITLE_CHARS, team) : []),
  ];
}

/**
 * `start`'s WAITING ON YOU block: the active tasks of other sessions that need the caller's unfinished tasks or wait
 * on its decision or approval, from the working set (a finished task waits on no one); `--all` lists every one.
 */
export async function waitingReport(args: ParsedArgs, runtime: CliRuntime): Promise<string[]> {
  const { own } = await settle(runtime, await ownRegister(runtime), () => false);
  const owner = sessionIdOf(own.roster, callerOf(args.flags, runtime.env));
  const tree = taskTreeOf(own, runtime);
  return waitingOnLines(owner, tree.waitingOn(owner), tree, args.switches.has('all'));
}

/**
 * `verify`: the caller's verifying tasks, oldest first, each with its proof and the date to verify by, then its done
 * tasks still watched for a sighting (`--watch`), if any, with what to do once it shows.
 */
export async function verify(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { own } = await settle(runtime, await ownRegister(runtime), () => false);
  const owner = sessionIdOf(own.roster, callerOf(args.flags, runtime.env));
  const zone = teamZone(own.config, runtime);
  const queue = verifyQueue(own.snapshot.state.tasks.values(), owner);
  runtime.out.stdout(`VERIFY ${queue.length} ${queue.length === 1 ? 'task' : 'tasks'} of ${owner}, oldest first`);
  queue.forEach((task) => runtime.out.stdout(formatVerifyRow(task, zone)));
  const watched = watchQueue(own.snapshot.state.tasks.values(), owner);
  if (watched.length > 0) {
    runtime.out.stdout(
      `WATCH ${watched.length} done ${watched.length === 1 ? 'task' : 'tasks'} of ${owner} waiting on a sighting: once it shows, set it done again without --watch; if it shows a fault, reopen it (--status in-progress)`,
    );
    watched.forEach((task) => runtime.out.stdout(formatWatchRow(task, zone)));
  }
  return EXIT.ok;
}

/** The `--week` given, else the newest week plan that has started in the team's `zone`. */
function weekFor(args: ParsedArgs, snapshot: RegisterSnapshot, now: Date, zone: TimeZone): string | null {
  const week = args.flags.get('week');
  return week === undefined ? currentWeekOf(snapshot, now, zone) : weekOf(week);
}

/**
 * The task flags of one register, against its own team's config and day, in its `zone`; with `team`, for
 * `check --tree`, its task ids name it. `leftPct` is what is left of the week's usage target (one account's limit
 * covers every team read). A wait on another register's task of the tree is judged against that task, and one on the
 * parent team's lead, `above`, is the lead's own approver's (T1140).
 */
function checkRegister(
  { snapshot, config, elsewhere, above }: Pick<RolledTeam, 'snapshot' | 'config' | 'elsewhere' | 'above'>,
  now: Date,
  zone: TimeZone,
  week: string | null,
  leftPct: number | undefined,
  team?: string,
): CheckSection {
  const tasks = [...snapshot.state.tasks.values()];
  const tree = new TaskTree(snapshot.state.tasks, now, zone, week, elsewhere);
  const dayStart = teamDayStartAt(config.wake.dayStartUtc, now.getTime());
  const progress = noProgressFlag({ tasks, tree, dayStart, days: config.register.check.goalProgressDays, leftPct });
  const flags = [...checkTasks(tasks, now, zone, week, config.register, elsewhere), ...peerWaitFlags(tasks, new LeadTree(config, above), config.roles, config.register.ownerSource), ...(progress === undefined ? [] : [progress])];
  return { team, flags: flags.sort(byFlagKind), tree };
}

/**
 * The week's fit to the weekly limit over every team read (one account's limit covers them all): what is left of
 * the own team's `budget.targetPct` after the newest status-line reading of the week on the account, which costs a
 * read of each account team's week summary (`weekUseOnAccount`; no transcript is measured). `labelled` names
 * each row's team, for a roll-up. `plan`, `check` and the meeting agenda (meeting.ts) read it.
 */
export async function weekFitOf(runtime: CliRuntime, { own, teams }: RollUp, week: string, labelled: boolean): Promise<WeekFit> {
  const { budget } = own.config;
  const now = runtime.clock.now();
  const use = await weekUseOnAccount(runtime, budget, own.paths, now);
  const rows = teams.flatMap((rolled) => {
    const tree = new TaskTree(rolled.snapshot.state.tasks, new Date(now), teamZone(rolled.config, runtime), week, rolled.elsewhere);
    return [...rolled.snapshot.state.tasks.values()].map((task) => (labelled ? { task, tree, team: rolled.team } : { task, tree }));
  });
  return weekFit(rows, week, use === undefined ? undefined : leftOfWeek(budget.targetPct, use.usedPct));
}

/** OVER-LIMIT goes to the section of the team holding the task: the only one without `--tree`. */
function withOverLimit(sections: readonly CheckSection[], fit: WeekFit): CheckSection[] {
  const flag = overLimitFlag(fit);
  return sections.map((section) =>
    flag !== undefined && section.team === fit.unfit?.row.team ? { ...section, flags: [...section.flags, flag].sort(byFlagKind) } : section,
  );
}

/**
 * What `check` reports: the task flags, then the skill flags of the Claude Code skills folder. With `--tree`,
 * the task flags of the lead's team and each team under it, against the lead's week; the skills are the lead's
 * team's only, as teams on one machine share that folder, less the skills another team of its tree reading that folder
 * owns, which that team's check lints (T1473), and so are the flags on hired sessions (src/hiring/due.ts)
 * and the batch of the owner's decisions its lead asks next (src/decisions/batch.ts), over its register and every
 * register under it, in a root team only (leadDecisionsOf).
 * The `stopgap T<id>` tags in those skills and in the team's `register.check.stopgapFiles` add a STOPGAP-DONE flag
 * per finished task they name. Last, doctor's context-size and context-lists findings against the own team's
 * `contextFiles` budgets: the text every call of a session on this machine re-reads (T393). Those findings, the
 * skill flags no session on the team owns, the own team's idle pass gone stale or failing (FLEET-STALE,
 * src/cli/idle-pass-check.ts), each of its repositories whose git hooks skip the secret scan (SECRET-HOOK,
 * src/cli/secret-hook-check.ts) and each secret guard key or settings file that turns a secret check off
 * (SECRET-GUARD-OFF, src/cli/secret-guard-off-check.ts) are the unowned warnings, which go to the lead
 * (src/cli/unowned.ts, T951).
 */
export async function checkReport(args: ParsedArgs, runtime: CliRuntime): Promise<CheckReport> {
  const now = new Date(runtime.clock.now());
  const tree = args.switches.has('tree');
  const read = await readRegisters(args, runtime);
  const skillFiles = await new SkillDir(runtime.files, read.own.paths.skills).readAll();
  const project = await projectFolder(runtime, read.own.config);
  const tags = [
    ...(await readStopgapTags(runtime.files, project, read.own.config.register.check.stopgapFiles)),
    ...skillFiles.flatMap((skill) => stopgapTags(`${skill.name}/${SKILL_FILE}`, skill.text)),
  ];
  // The task flags read active tasks and, for NO-PROGRESS, tasks finished inside its span, which a compaction never
  // retires (limits.ts); a stopgap tag may name a finished task it retired, so only a tag the own team's working set
  // lacks makes it read that team's whole history.
  const working = read.own.snapshot;
  const { own, teams } = await settle(runtime, read, (_retired, snapshot) => snapshot === working && tags.some((tag) => !snapshot.state.tasks.has(tag.id)));
  const zone = teamZone(own.config, runtime);
  const week = weekFor(args, own.snapshot, now, zone);
  const bursts = await readBursts(runtime, own.paths, own.config.budget, now.getTime());
  const { usedPct } = bursts;
  const leftPct = usedPct === undefined ? undefined : leftOfWeek(own.config.budget.targetPct, usedPct);
  // OVER-SIZE reads the own team's metered use, as STOPGAP-DONE reads its files: a sub-team's sessions meter in its own home.
  const { overSizeMultiple } = own.config.register.check;
  const spent = overSizeMultiple > 0 ? await readTaskSpend(runtime, own.paths, own.config, now.getTime()) : undefined;
  const checked = teams.map((rolled) => {
    const section = checkRegister(rolled, now, teamZone(rolled.config, runtime), week, leftPct, tree ? rolled.team : undefined);
    const ownFlags =
      rolled.team === own.team
        ? [...stopgapFlags(tags, rolled.snapshot.state.tasks, zone), ...(spent === undefined ? [] : overSizeFlags(rolled.snapshot.state.tasks.values(), spent, overSizeMultiple))]
        : [];
    return { ...section, flags: [...section.flags, ...ownFlags].sort(byFlagKind) };
  });
  const sections = week === null || week !== currentWeekOf(own.snapshot, now, zone) ? checked : withOverLimit(checked, await weekFitOf(runtime, { own, teams }, week, tree));
  const { records } = await new HiringLog(runtime.files, own.paths.hires).read();
  const over = burstsOver(bursts.records, now.getTime(), usedPct);
  const tasks = [...own.snapshot.state.tasks.values()];
  const { spare, hirePct } = await readScaleOutBudget(runtime, own.paths, own.config, tasks, bursts, now.getTime());
  const input = { hires: activeHires(records), config: own.config, burstsOver: over, now };
  const scaleOut = scaleOutFlags({ ...input, tasks, tree: new TaskTree(own.snapshot.state.tasks, now, zone, week, own.elsewhere), spare, hirePct });
  const hires = [...scaleOut, ...hireFlags(input)];
  const scope = week === null ? 'no week plan tagged yet, so the week checks are skipped' : `week ${week}`;
  const loaded = await loadTree(runtime);
  const decisions = await leadDecisionsOf(runtime, own, loaded, now.getTime(), zone);
  const context = contextSizeFindings(await readContextInput(runtime, project, own.paths.skills, own.config.contextFiles));
  const allow = allowFindings(await readWideAllow(runtime, { paths: own.paths, config: own.config, project }));
  const lint = lintSkills(skillFiles, now, own.config, skillOwnersElsewhere(loaded, own.paths));
  const { skills, unowned } = splitUnowned([...context, ...allow], lint, new Set(own.config.sessions), own.paths.skills);
  const idle = await idlePassWarnings(runtime.files, own.paths, own.config.open.idle.mode, now.getTime());
  const hooks = await secretHookWarnings(runtime.files, runtime.secretsGit, own.paths, own.config.delivery.repos);
  const settings = await teamSettingsScope(runtime, { paths: own.paths, config: own.config, project });
  const off = await secretGuardOffWarnings(runtime.files, own.config.secretGuard, settings);
  const lead = own.config.roles.lead;
  return { sections, scope, skills, skillsDir: own.paths.skills, hires, unowned: [...unowned, ...idle, ...hooks, ...off], lead, decisions };
}

/**
 * The batch of the owner's decisions a root team's lead asks next, over its register and every register under it; none
 * in a child team, whose waits the lead at its tree's root asks (T1018).
 */
async function leadDecisionsOf(runtime: CliRuntime, own: RolledTeam, loaded: KitTree, now: number, zone: TimeZone): Promise<LeadDecisions | undefined> {
  if (loaded.tree.ownerLeadAbove(own.team) !== undefined) {
    return undefined;
  }
  const { batch } = await ownerBatchOf(runtime, { team: own.team, config: own.config, paths: own.paths, tasks: own.snapshot.state.tasks, elsewhere: own.elsewhere }, loaded, now);
  return { lead: own.config.roles.lead, batch, zone };
}

/** `check [--tree] [--all]`: the report in the short form (src/cli/reports.ts), or with `--all` every flag in full. */
export async function check(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  checkLines(await checkReport(args, runtime), args.switches.has('all')).forEach((line) => runtime.out.stdout(line));
  return EXIT.ok;
}

/**
 * `plan [--tree]`: with `--tree`, one section per team, the lead's team first, for the lead's week. The week's fit
 * to the weekly limit sits under the first section's counts, for the week in force only (the limit read is this
 * week's): with `--tree`, one fit over every team shown.
 */
export async function plan(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const now = new Date(runtime.clock.now());
  const tree = args.switches.has('tree');
  const read = await readRegisters(args, runtime);
  const zone = teamZone(read.own.config, runtime);
  const week = weekFor(args, read.own.snapshot, now, zone);
  const settled = await settle(runtime, read, week === null ? () => false : weekMayBeRetired(week));
  if (week === null) {
    throw new RefusedError('no week plan tagged yet; pass --week <YYYY-MM-DD>');
  }
  const fit = week === currentWeekOf(settled.own.snapshot, now, zone) ? fitLines(await weekFitOf(runtime, settled, week, tree)) : [];
  const sections = settled.teams.map((rolled, index) =>
    renderPlan(rolled.snapshot.state.tasks.values(), week, now, teamZone(rolled.config, runtime), rolled.config.register, {
      team: tree ? rolled.team : undefined,
      fit: index === 0 ? fit : [],
      elsewhere: rolled.elsewhere,
    }),
  );
  runtime.out.stdout(sections.join('\n\n'));
  return EXIT.ok;
}
