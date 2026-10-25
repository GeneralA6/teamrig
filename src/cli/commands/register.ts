import { LeadTree } from '../../config/lead-tree.ts';
import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { formatAddress, splitAddress } from '../../core/address.ts';
import type { TeamPaths } from '../../core/home.ts';
import type { TimeZone } from '../../core/zone.ts';
import { JsonlDailyLog } from '../../core/daily-log.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { burstsOver } from '../../budget/burst.ts';
import { formatW } from '../../budget/format.ts';
import { timingText, waitTiming, type WaitTiming } from '../../decisions/lines.ts';
import { teamDecisions } from '../../decisions/team.ts';
import { allowFindings, contextSizeFindings } from '../../doctor/doctor.ts';
import { hireFlags } from '../../hiring/due.ts';
import { HiringLog } from '../../hiring/log.ts';
import { activeHires } from '../../hiring/record.ts';
import { scaleOutFlags } from '../../hiring/scale-out.ts';
import { postLine } from '../../inbox/inbox.ts';
import { weekUseOf } from '../../budget/snapshot.ts';
import { teamDayStartAt } from '../../wake/day-start.ts';
import { byFlagKind, checkTasks, peerWaitFlags } from '../../register/check.ts';
import { currentWeekOf } from '../../register/week.ts';
import type { ApprovalVerdict, TaskFields } from '../../register/events.ts';
import { fitLines, leftOfWeek, overLimitFlag, weekFit, type WeekFit } from '../../register/fit.ts';
import type { Task } from '../../register/fold.ts';
import { problemHint } from '../../register/kind.ts';
import { reviewGap, reviewGapText } from '../../register/review.ts';
import { renderPlan } from '../../register/plan.ts';
import { noProgressFlag } from '../../register/progress.ts';
import { overSizeFlags } from '../../register/over-size.ts';
import type { AddInput, AskInput, StatusInput, Verdict } from '../../register/policy.ts';
import type { Register, WriteResult } from '../../register/register.ts';
import { ACTIVE_STATUSES, type TaskStatus } from '../../register/model.ts';
import type { RegisterSnapshot, RetiredTasks } from '../../register/snapshot.ts';
import { readStopgapTags, stopgapFlags, stopgapTags } from '../../register/stopgap.ts';
import { dueStartHolds, dueVerifyHold, heldStart, heldStartNotice, metStartNotice, startHolds, verifyQueue, type DueVerify } from '../../register/verify.ts';
import { readAs, TaskTree, type TaskElsewhere } from '../../register/tree.ts';
import { approvalNotice, assignedNotice, endedNotice, formatTask, formatTaskDetail, formatTaskTree, formatVerifyRow, personWaitNotice, selectTasks, type ListFilter } from '../../register/views.ts';
import { isPeerWait, sameWait, type PersonWait } from '../../register/waits.ts';
import { lintSkills } from '../../skills/lint.ts';
import { SKILL_FILE, SkillDir } from '../../skills/store.ts';
import { snapshotsOnAccount } from '../account-teams.ts';
import { readWideAllow } from '../allow-scope.ts';
import { noPositionals, onePositional, UsageError, type ParsedArgs } from '../args.ts';
import { addInputOf, callerOf, changesOf, listFilterOf, pinOf, setInputOf, taskIdOf, weekOf, type TypedTimes } from '../inputs.ts';
import { findTeam, openKit, openTeamKit, pastOrPresentIdOf, projectFolder, requireConfig, rosterOf, sessionIdOf, teamZone, type Access, type Kit } from '../kit.ts';
import { checkLines, listLines, SHORT_TITLE_CHARS, waitingOnLines, type CheckReport, type CheckSection, type TaskRow } from '../reports.ts';
import { idlePassWarnings } from '../idle-pass-check.ts';
import { rollUp, type RolledTeam, type RollUp } from '../roll-up.ts';
import { splitUnowned } from '../unowned.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { teamRegister } from '../team-register.ts';
import { readBursts } from '../burst-reading.ts';
import { readScaleOutBudget } from '../hire-cost.ts';
import { readWPerPct } from '../stored-week.ts';
import { readTaskSpend } from '../task-spend.ts';
import { readContextInput } from './doctor.ts';
import { inboxDepsOf } from './inbox.ts';
import { markBoundary } from './refresh.ts';
import { markKeepWorkingAsk } from './keep-working.ts';
import { markRetireAsk } from './retire-ask.ts';

interface Team {
  readonly config: KitConfig;
  readonly paths: TeamPaths;
  readonly register: Register;
  readonly roster: Roster;
  /** The zone the team's people read and type times in. */
  readonly zone: TimeZone;
}

/** What a time the caller types is read against: this moment and the zone of the caller's own team. */
function typedTimes(runtime: CliRuntime, zone: TimeZone): TypedTimes {
  return { nowMs: runtime.clock.now(), zone };
}

async function teamOf(runtime: CliRuntime, kit: Kit, access: Access): Promise<Team> {
  const config = requireConfig(kit, runtime, access);
  return { config, paths: kit.paths, register: teamRegister(runtime, kit.paths, config), roster: await rosterOf(runtime, kit, config), zone: teamZone(config, runtime) };
}

async function openTeam(runtime: CliRuntime, access: Access): Promise<Team> {
  return teamOf(runtime, await openTeamKit(runtime), access);
}

/** The owner as an id; a source naming a session becomes its id, the owner's marker or a past session's id stays. */
function addInputIds(team: Team, input: AddInput): AddInput {
  const source = input.source === team.config.register.ownerSource ? input.source : pastOrPresentIdOf(team.roster, input.source);
  return { ...input, owner: sessionIdOf(team.roster, input.owner), source };
}

/** Who a decision or an approval waits for, as an id: a session's name becomes its id, the owner's marker stays. */
function statusInputIds(team: Team, input: StatusInput): StatusInput {
  if (input.waits === undefined) {
    return input;
  }
  const { ownerSource } = team.config.register;
  const waits = input.waits.map((reason) =>
    (reason.kind === 'decision' || reason.kind === 'approval') && reason.who !== ownerSource
      ? { kind: reason.kind, who: sessionIdOf(team.roster, reason.who) }
      : reason,
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
function warnDamage(runtime: CliRuntime, snapshot: RegisterSnapshot, path: string): void {
  const { unreadable, newer } = snapshot.read;
  const { orphans } = snapshot.state;
  if (unreadable + newer + orphans > 0) {
    runtime.out.stderr(
      `WARN ${path}: ${unreadable} unreadable line(s), ${newer} line(s) from a newer teamrig, ${orphans} event(s) naming no task`,
    );
  }
}

/**
 * `add --team <child>`: a parent team's lead hands a child team a task. It lands in the child's
 * register as an event by `<parent team>/<lead id>`, which is also its source, owned by the child's
 * lead, who plans it in and gets an inbox line from that address. Only the child's parent lead may; the
 * parent's register is not touched.
 */
async function addToChild(args: ParsedArgs, runtime: CliRuntime, caller: string, child: string): Promise<ExitCode> {
  if (args.flags.has('owner') || args.flags.has('source')) {
    throw new UsageError("--team gives the task to that team's lead, from you: it takes no --owner or --source");
  }
  const { team } = await findTeam(runtime);
  const kit = await openKit(runtime, team);
  const config = requireConfig(kit, runtime, 'read');
  const from = { team, id: sessionIdOf(await rosterOf(runtime, kit, config), caller) };
  const { tree } = await loadTree(runtime);
  const childLead = tree.leadOf(child);
  if (childLead === undefined) {
    throw new RefusedError(`no team ${child} with a config in this kit home`);
  }
  const parentLead = tree.parentLeadOf(child);
  if (parentLead === undefined) {
    throw new RefusedError(`team ${child} has no parent team, so only its own sessions add its tasks`);
  }
  if (parentLead.team !== from.team || parentLead.id !== from.id) {
    throw new RefusedError(`only ${child}'s parent lead (${formatAddress(parentLead)}) adds tasks to it; ${formatAddress(from)} may not`);
  }
  const target = await teamOf(runtime, await openKit(runtime, child), 'write');
  const input = { ...addInputOf(args.flags, caller, typedTimes(runtime, teamZone(config, runtime))), owner: childLead, source: formatAddress(from) };
  const verdict = await target.register.addFromParent(formatAddress(from), input);
  const code = report(runtime, verdict, 'ADDED', target, child);
  if (verdict.ok) {
    await tellAssigned(runtime, target, formatAddress(from), verdict.value.task, formatAddress({ team: child, id: childLead }));
  }
  return code;
}

export async function add(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const caller = callerOf(args.flags, runtime.env);
  const child = args.flags.get('team');
  if (child !== undefined) {
    return addToChild(args, runtime, caller, child);
  }
  const team = await openTeam(runtime, 'write');
  const input = addInputOf(args.flags, caller, typedTimes(runtime, team.zone));
  const by = sessionIdOf(team.roster, caller);
  const verdict = await team.register.add(by, addInputIds(team, input));
  const code = report(runtime, verdict, 'ADDED', team);
  if (verdict.ok) {
    noteProblemHint(runtime, team, verdict.value.task);
  }
  await tellNewOwner(runtime, team, by, verdict);
  return code;
}

/** A NOTE asking to mark the task a problem when its text reads like one and no one marked it (register/kind.ts). */
function noteProblemHint(runtime: CliRuntime, team: Team, task: Task): void {
  const hint = problemHint(task, team.config.register.review.hintPattern);
  if (hint !== undefined) {
    runtime.out.stderr(`NOTE ${hint}`);
  }
}

/**
 * A WARN naming the review parts a problem task reached `status` without, while `register.review.mode` is `warn`
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

/** One inbox line telling a task's owner the task is its own; `shown` names the owner in the NOTE (another team's by address). */
async function tellAssigned(runtime: CliRuntime, team: Team, by: string, task: Task, shown = task.owner): Promise<void> {
  await tellLine(runtime, team, by, task.owner, assignedNotice(task, team.zone), `${shown} was not told of ${task.id}`, shown);
}

/**
 * One inbox line to each leader that a write set a task waiting on, or a verifying task's proof, for a decision or an
 * approval it did not wait on before: a wait on one of the task owner's leaders (the lead, or a sub-lead, T781) goes
 * to that leader, a wait on the owner to the task owner's own leader, which passes it up (the lead keeps the owner's
 * decision queue and asks it in its batch); never to the leader who set it. A new wait on the owner says when the owner
 * hears it (src/decisions/batch.ts): in the next batch, in the one due now, or at once when it is due before the next;
 * at once, the setter is told to message the lead too, as an inbox line wakes no one.
 */
async function tellLeadersOfWaits(runtime: CliRuntime, team: Team, by: string, verdict: Verdict<WriteResult>): Promise<void> {
  if (!verdict.ok) {
    return;
  }
  const { lead } = team.config.roles;
  const { ownerSource } = team.config.register;
  const { task, before } = verdict.value;
  const earlier = before?.waits ?? [];
  const leaders = new LeadTree(team.config);
  const approvers = leaders.approversOf(task.owner);
  const added = task.waits.filter(
    (reason): reason is PersonWait =>
      (reason.kind === 'decision' || reason.kind === 'approval') && !isPeerWait(reason, approvers, ownerSource) && !earlier.some((other) => sameWait(reason, other)),
  );
  const ownLeader = leaders.leaderOf(task.owner) ?? lead;
  const receiverOf = (reason: PersonWait) => (reason.who === ownerSource ? ownLeader : reason.who);
  for (const receiver of new Set(added.map(receiverOf))) {
    if (receiver === by) {
      continue;
    }
    const waits = added.filter((reason) => receiverOf(reason) === receiver);
    const timing = waits.some((reason) => reason.who === ownerSource) ? await ownerWaitTiming(runtime, team, verdict.value) : undefined;
    const text = `${personWaitNotice(task, waits, receiver)}${timing === undefined ? '' : ` | ${timingText(timing, team.zone)}`}`;
    await tellLine(runtime, team, by, receiver, text, `${receiver} was not told that ${task.id} waits on it`);
    if (timing?.kind === 'at-once') {
      const leadName = team.roster.nameOf(lead) ?? lead;
      const how = receiver === lead ? ' too, as an inbox line wakes no one' : `, who asks the owner: the inbox line went to ${receiver}, and a line wakes no one`;
      runtime.out.stderr(`NOTE ${task.id} is due before the owner's next batch: message ${leadName}${how}`);
    }
  }
}

/** When the owner hears of a task's new wait on them, judged on the register after the write. */
async function ownerWaitTiming(runtime: CliRuntime, team: Team, { task, state, elsewhere }: WriteResult): Promise<WaitTiming> {
  const now = runtime.clock.now();
  const { batch, tree } = await teamDecisions(runtime.files, team.paths, team.config, state.tasks, now, team.zone, elsewhere);
  return waitTiming(batch, task, tree, now);
}

/** Posts one inbox line, naming it on stderr, or naming `unsent` and why: a line that cannot be posted is never thrown. */
async function tellLine(runtime: CliRuntime, team: Team, by: string, to: string, text: string, unsent: string, shown = to): Promise<void> {
  await postNamed(runtime, team.paths, new SecretScanner(team.config.register.secretPatterns), { to, from: by, text }, unsent, shown);
}

/** Posts one line to an inbox of the team at `paths`, naming it on stderr as `shown`, or naming `unsent` and why. */
async function postNamed(
  runtime: CliRuntime,
  paths: TeamPaths,
  secrets: SecretScanner,
  line: { readonly to: string; readonly from: string; readonly text: string },
  unsent: string,
  shown: string,
): Promise<void> {
  const { inboxes } = inboxDepsOf(runtime, paths);
  const problem = await postLine(inboxes, secrets, { ...line, now: new Date(runtime.clock.now()) });
  runtime.out.stderr(problem === undefined ? `NOTE ${shown} has an inbox line: ${line.text}` : `WARN ${unsent}: ${problem}`);
}

/**
 * One inbox line to the parent team's lead when a task the parent handed this team (`add --team`, its source
 * `<parent>/<id>`) ends, done or dropped (T509): the parent's register holds no copy of it, so the line is how the
 * parent hears. It goes to whoever leads the parent now, under `<team>/<setter>`, scanned with both teams' secret
 * patterns; a task from any other team tells no one. A line that cannot be posted is named, never thrown.
 */
async function tellParentOfEnd(runtime: CliRuntime, team: Team, by: string, verdict: Verdict<WriteResult>): Promise<void> {
  const link = team.config.team;
  if (!verdict.ok || link?.parent === undefined) {
    return;
  }
  const { task, before } = verdict.value;
  if (ACTIVE_STATUSES.includes(task.status) || before?.status === task.status || splitAddress(task.source)?.team !== link.parent) {
    return;
  }
  const text = endedNotice(task, link.id);
  const { tree, teams } = await loadTree(runtime);
  const lead = tree.parentLeadOf(link.id);
  const parent = teams.get(link.parent);
  if (lead === undefined || parent === undefined) {
    runtime.out.stderr(`WARN ${link.parent}'s lead was not told that ${link.id}/${task.id} ended: team ${link.parent} has no config in this kit home`);
    return;
  }
  const shown = formatAddress(lead);
  const secrets = new SecretScanner([...team.config.register.secretPatterns, ...parent.config.register.secretPatterns]);
  await postNamed(runtime, parent.kit.paths, secrets, { to: lead.id, from: formatAddress({ team: link.id, id: by }), text }, `${shown} was not told that ${link.id}/${task.id} ended`, shown);
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
    noteProblemHint(runtime, team, verdict.value.task);
  }
  await tellLeadersOfWaits(runtime, team, by, verdict);
  await tellParentOfEnd(runtime, team, by, verdict);
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
    await markRetireAsk(runtime, config, paths, verdict.value);
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

export async function update(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = taskIdOf(onePositional(args, 'id'));
  const caller = callerOf(args.flags, runtime.env);
  const team = await openTeam(runtime, 'write');
  const by = sessionIdOf(team.roster, caller);
  const changes = { ...changesOf(args.flags, typedTimes(runtime, team.zone)), ...pinOf(args.switches, by) };
  const verdict = await team.register.update(by, id, changeIds(team.roster, changes), args.flags.get('note'));
  const code = report(runtime, verdict, 'UPDATED', team);
  await tellNewOwner(runtime, team, by, verdict);
  return code;
}

/**
 * `approve <id> --note ".." [--decline]`: the lead's answer to a task waiting on its approval (T684); the task's owner
 * gets one inbox line with the answer and the note, and pushes or merges (or fixes what the note names) at once.
 */
export async function approve(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = taskIdOf(onePositional(args, 'id'));
  const caller = callerOf(args.flags, runtime.env);
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
  const { config, paths, roster, register } = await openTeam(runtime, 'read');
  const [snapshot, elsewhere] = await Promise.all([register.snapshot(), register.elsewhere()]);
  const own: RolledTeam = { team: paths.team, config, paths, roster, snapshot, history: () => register.history(), elsewhere };
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
function taskTreeOf({ snapshot, config, elsewhere }: Pick<RolledTeam, 'snapshot' | 'config' | 'elsewhere'>, runtime: CliRuntime): TaskTree {
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
 * `show <id> [--tree]`: every field of the task and its history; with `--tree`, its line, then what it needs and what
 * needs it, each node with its owner, status and due, then who moves next (views.ts formatTaskTree). A task another
 * register of the team tree holds shows read-only ({@link elsewhereLines}).
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
    return EXIT.ok;
  }
  const tree = taskTreeOf(own, runtime);
  if (args.switches.has('tree')) {
    [formatTask(task, undefined, tree), ...formatTaskTree(task, tree, SHORT_TITLE_CHARS)].forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
  }
  const events = snapshot.read.events.filter((event) => event.id === id);
  const wPerPct = task.size === null ? undefined : await readWPerPct(runtime, own.paths, own.config, runtime.clock.now());
  runtime.out.stdout(formatTaskDetail(task, events, tree, (pct) => (wPerPct === undefined ? undefined : `about ${formatW(pct * wPerPct)} W`)));
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

/** `verify`: the caller's verifying tasks, oldest first, each with its proof and the date to verify by. */
export async function verify(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { own } = await settle(runtime, await ownRegister(runtime), () => false);
  const owner = sessionIdOf(own.roster, callerOf(args.flags, runtime.env));
  const queue = verifyQueue(own.snapshot.state.tasks.values(), owner);
  runtime.out.stdout(`VERIFY ${queue.length} ${queue.length === 1 ? 'task' : 'tasks'} of ${owner}, oldest first`);
  queue.forEach((task) => runtime.out.stdout(formatVerifyRow(task, teamZone(own.config, runtime))));
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
 * covers every team read). A wait on another register's task of the tree is judged against that task.
 */
function checkRegister(
  { snapshot, config, elsewhere }: Pick<RolledTeam, 'snapshot' | 'config' | 'elsewhere'>,
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
  const flags = [...checkTasks(tasks, now, zone, week, config.register, elsewhere), ...peerWaitFlags(tasks, new LeadTree(config), config.register.ownerSource), ...(progress === undefined ? [] : [progress])];
  return { team, flags: flags.sort(byFlagKind), tree };
}

/**
 * The week's fit to the weekly limit over every team read (one account's limit covers them all): what is left of
 * the own team's `budget.targetPct` after the newest status-line reading of the week on the account, which costs a
 * read of each account team's snapshot folder (`snapshotsOnAccount`; no transcript is measured). `labelled` names
 * each row's team, for a roll-up. `plan`, `check` and the meeting agenda (meeting.ts) read it.
 */
export async function weekFitOf(runtime: CliRuntime, { own, teams }: RollUp, week: string, labelled: boolean): Promise<WeekFit> {
  const { budget } = own.config;
  const now = runtime.clock.now();
  const use = weekUseOf(await snapshotsOnAccount(runtime, budget, own.paths), now);
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
 * team's only, as teams on one machine share that folder, and so are the flags on hired sessions (src/hiring/due.ts)
 * and the batch of the owner's decisions its lead asks next (src/decisions/batch.ts).
 * The `stopgap T<id>` tags in those skills and in the team's `register.check.stopgapFiles` add a STOPGAP-DONE flag
 * per finished task they name. Last, doctor's context-size and context-lists findings against the own team's
 * `contextFiles` budgets: the text every call of a session on this machine re-reads (T393). Those findings, the
 * skill flags no session on the team owns and the own team's idle pass gone stale or failing (FLEET-STALE,
 * src/cli/idle-pass-check.ts) are the unowned warnings, which go to the lead (src/cli/unowned.ts, T951).
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
  const input = { hires: activeHires(records), tasks, config: own.config, burstsOver: over, now };
  const scaleOut = scaleOutFlags({ ...input, tree: new TaskTree(own.snapshot.state.tasks, now, zone, week, own.elsewhere), spare, hirePct });
  const hires = [...scaleOut.flags, ...hireFlags(input, scaleOut.busy)];
  const scope = week === null ? 'no week plan tagged yet, so the week checks are skipped' : `week ${week}`;
  const { batch } = await teamDecisions(runtime.files, own.paths, own.config, own.snapshot.state.tasks, now.getTime(), zone, own.elsewhere);
  const context = contextSizeFindings(await readContextInput(runtime, project, own.paths.skills, own.config.contextFiles));
  const allow = allowFindings(await readWideAllow(runtime, { paths: own.paths, config: own.config, project }));
  const { skills, unowned } = splitUnowned([...context, ...allow], lintSkills(skillFiles, now, own.config), new Set(own.config.sessions), own.paths.skills);
  const idle = await idlePassWarnings(runtime.files, own.paths, own.config.open.idle.mode, now.getTime());
  const lead = own.config.roles.lead;
  return { sections, scope, skills, skillsDir: own.paths.skills, hires, unowned: [...unowned, ...idle], lead, decisions: { lead, batch, zone } };
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
