import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { formatAddress } from '../../core/address.ts';
import type { TeamPaths } from '../../core/home.ts';
import { JsonlDailyLog } from '../../core/daily-log.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { hireFlags } from '../../hiring/due.ts';
import { activeHires, HiringLog } from '../../hiring/log.ts';
import { postLine } from '../../inbox/inbox.ts';
import { readSnapshots, weekUseOf } from '../../budget/snapshot.ts';
import { byFlagKind, checkTasks, currentWeekOf } from '../../register/check.ts';
import type { TaskFields } from '../../register/events.ts';
import { fitLines, leftOfWeek, overLimitFlag, weekFit, type WeekFit } from '../../register/fit.ts';
import type { Task } from '../../register/fold.ts';
import { renderPlan } from '../../register/plan.ts';
import type { AddInput, StatusInput, Verdict } from '../../register/policy.ts';
import type { Register, WriteResult } from '../../register/register.ts';
import { ACTIVE_STATUSES } from '../../register/model.ts';
import type { RegisterSnapshot, RetiredTasks } from '../../register/snapshot.ts';
import { readStopgapTags, stopgapFlags, stopgapTags } from '../../register/stopgap.ts';
import { heldStart, heldStartNotice, startHolds, verifyQueue } from '../../register/verify.ts';
import { assignedNotice, formatTask, formatTaskDetail, formatVerifyRow, selectTasks, type ListFilter } from '../../register/views.ts';
import { waitContext, type WaitContext } from '../../register/waits.ts';
import { lintSkills } from '../../skills/lint.ts';
import { SKILL_FILE, SkillDir } from '../../skills/store.ts';
import { noPositionals, onePositional, UsageError, type ParsedArgs } from '../args.ts';
import { addInputOf, callerOf, changesOf, listFilterOf, statusInputOf, taskIdOf, weekOf } from '../inputs.ts';
import { findTeam, openKit, openTeamKit, pastOrPresentIdOf, projectFolder, requireConfig, rosterOf, sessionIdOf, type Access, type Kit } from '../kit.ts';
import { checkLines, listLines, type CheckReport, type CheckSection, type TaskRow } from '../reports.ts';
import { rollUp, type RolledTeam, type RollUp } from '../roll-up.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { teamRegister } from '../team-register.ts';
import { snapshotDirOf } from './budget.ts';
import { inboxDepsOf } from './inbox.ts';
import { markBoundary } from './refresh.ts';
import { markRetireAsk } from './retire-ask.ts';

interface Team {
  readonly config: KitConfig;
  readonly paths: TeamPaths;
  readonly register: Register;
  readonly roster: Roster;
}

async function teamOf(runtime: CliRuntime, kit: Kit, access: Access): Promise<Team> {
  const config = requireConfig(kit, runtime, access);
  return { config, paths: kit.paths, register: teamRegister(runtime, kit.paths, config), roster: await rosterOf(runtime, kit, config) };
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
 * The written task's line; `team` names another team's register, so its id reads `<team>/T12`. A rotation
 * the write ran is named on stderr, so the task line stays the one line a script reads, with the switch
 * that turns it off in `configPath`, the config of the team whose register was written.
 */
function report(runtime: CliRuntime, verdict: Verdict<WriteResult>, verb: string, configPath: string, team?: string): ExitCode {
  if (!verdict.ok) {
    throw new RefusedError(verdict.error);
  }
  const { task, state } = verdict.value;
  runtime.out.stdout(`${verb} ${formatTask(task, team, waitContext(state.tasks, new Date(runtime.clock.now())))}`);
  const { rotation } = verdict.value;
  const turnOff = autoArchiveSwitch(configPath);
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
 * lead, who plans it in. Only the child's parent lead may; the parent's register is not touched.
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
  const input = { ...addInputOf(args.flags, caller), owner: childLead, source: formatAddress(from) };
  return report(runtime, await target.register.addFromParent(formatAddress(from), input), 'ADDED', target.paths.config, child);
}

export async function add(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const caller = callerOf(args.flags, runtime.env);
  const child = args.flags.get('team');
  if (child !== undefined) {
    return addToChild(args, runtime, caller, child);
  }
  const input = addInputOf(args.flags, caller);
  const team = await openTeam(runtime, 'write');
  const by = sessionIdOf(team.roster, caller);
  const verdict = await team.register.add(by, addInputIds(team, input));
  const code = report(runtime, verdict, 'ADDED', team.paths.config);
  await tellNewOwner(runtime, team, by, verdict);
  return code;
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
  const text = assignedNotice(task);
  const { inboxes } = inboxDepsOf(runtime, team.paths);
  const secrets = new SecretScanner(team.config.register.secretPatterns);
  const problem = await postLine(inboxes, secrets, { to: task.owner, from: by, text, now: new Date(runtime.clock.now()) });
  runtime.out.stderr(problem === undefined ? `NOTE ${task.owner} has an inbox line: ${text}` : `WARN ${task.owner} was not told of ${task.id}: ${problem}`);
}

export async function set(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = taskIdOf(onePositional(args, 'id'));
  const caller = callerOf(args.flags, runtime.env);
  const typed = statusInputOf(args.flags);
  const team = await openTeam(runtime, 'write');
  const { config, paths, register, roster } = team;
  const by = sessionIdOf(roster, caller);
  const input = statusInputIds(team, typed);
  const held = await heldStartOf(register, by, id, input);
  const verdict = await register.setStatus(by, id, input);
  const warned = config.register.verifyGate === 'warn';
  if (held !== undefined && verdict.ok === warned) {
    await tellVerifiers(runtime, team, by, held);
  }
  const exit = report(runtime, verdict, 'SET', paths.config);
  if (held !== undefined && warned) {
    runtime.out.stderr(`WARN ${heldStart(held.task, held.holds)}; started anyway, as register.verifyGate is warn`);
  }
  if (input.status === 'done') {
    await markBoundary(runtime, config, paths, by, id);
  }
  if (verdict.ok && (input.status === 'done' || input.status === 'dropped')) {
    await markRetireAsk(runtime, config, paths, verdict.value);
  }
  return exit;
}

/** A start the verifying tasks it needs hold: the task, as the caller's own, and those tasks. */
interface HeldStart {
  readonly task: Task;
  readonly holds: readonly Task[];
}

/**
 * The verifying tasks that hold the caller's start of its own task, read before the write: the policy
 * refuses that start (or lets it through in warn mode), and their owners hear of it either way.
 */
async function heldStartOf(register: Register, caller: string, id: string, input: StatusInput): Promise<HeldStart | undefined> {
  if (input.status !== 'in-progress') {
    return undefined;
  }
  const { tasks } = (await register.snapshot()).state;
  const task = tasks.get(id);
  const holds = task === undefined || task.owner !== caller ? [] : startHolds(task, input.status, tasks);
  return task === undefined || holds.length === 0 ? undefined : { task, holds };
}

/**
 * One inbox line to the owner of each verifying task that holds a start, once per task pair and UTC
 * day, never to the caller, who reads the refusal. A line that cannot be posted is named, never thrown.
 */
async function tellVerifiers(runtime: CliRuntime, team: Team, caller: string, { task, holds }: HeldStart): Promise<void> {
  const now = new Date(runtime.clock.now());
  const told = new JsonlDailyLog(runtime.files, team.paths.verifyNotices);
  const { inboxes } = inboxDepsOf(runtime, team.paths);
  const secrets = new SecretScanner(team.config.register.secretPatterns);
  for (const held of holds) {
    const key = `held ${task.id} on ${held.id}`;
    if (held.owner === caller || (await told.seen(key, now))) {
      continue;
    }
    const text = heldStartNotice(task, held);
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
  const changes = changesOf(args.flags);
  const team = await openTeam(runtime, 'write');
  const by = sessionIdOf(team.roster, caller);
  const verdict = await team.register.update(by, id, changeIds(team.roster, changes), args.flags.get('note'));
  const code = report(runtime, verdict, 'UPDATED', team.paths.config);
  await tellNewOwner(runtime, team, by, verdict);
  return code;
}

/** A filter for one team of a roll-up: a source that names one of its sessions becomes its id. */
function treeFilterOf(roster: Roster, filter: ListFilter): ListFilter {
  const found = filter.source === undefined ? undefined : roster.lookup(filter.source);
  return found?.ok === true ? { ...filter, source: found.id } : filter;
}

/** The caller's own register, as a roll-up of one team. */
async function ownRegister(runtime: CliRuntime): Promise<RollUp> {
  const { config, paths, roster, register } = await openTeam(runtime, 'read');
  const own: RolledTeam = { team: paths.team, config, paths, roster, snapshot: await register.snapshot(), history: () => register.history() };
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

/** How a read of one register judges its waiting tasks' reasons now. */
function contextOf(snapshot: RegisterSnapshot, runtime: CliRuntime): WaitContext {
  return waitContext(snapshot.state.tasks, new Date(runtime.clock.now()));
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
  const filter = listFilterOf(new Map([...args.flags].filter(([name]) => name !== 'session')));
  const { teams } = await settle(runtime, await rollUp(runtime, callerOf(args.flags, runtime.env)), selectsFinished(filter));
  return teams.flatMap(({ team, roster, snapshot }) => {
    const context = contextOf(snapshot, runtime);
    return selectTasks(snapshot.state.tasks.values(), treeFilterOf(roster, filter)).map((task) => ({ task, team, context }));
  });
}

async function ownRows(args: ParsedArgs, runtime: CliRuntime): Promise<TaskRow[]> {
  const filter = listFilterOf(args.flags);
  const { own } = await settle(runtime, await ownRegister(runtime), selectsFinished(filter));
  const context = contextOf(own.snapshot, runtime);
  return selectTasks(own.snapshot.state.tasks.values(), filterIds(own.roster, filter)).map((task) => ({ task, team: undefined, context }));
}

/** `list [--tree] [--all]`: the short form (src/cli/reports.ts), or with `--all` every field of every task. */
export async function list(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const rows = args.switches.has('tree') ? await treeRows(args, runtime) : await ownRows(args, runtime);
  listLines(rows, args.switches.has('all')).forEach((line) => runtime.out.stdout(line));
  return EXIT.ok;
}

export async function show(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = taskIdOf(onePositional(args, 'id'));
  const { own } = await settle(runtime, await ownRegister(runtime), (_retired, working) => !working.state.tasks.has(id));
  const { snapshot } = own;
  const task = snapshot.state.tasks.get(id);
  if (task === undefined) {
    throw new RefusedError(`no task ${id}`);
  }
  runtime.out.stdout(formatTaskDetail(task, snapshot.read.events.filter((event) => event.id === id), contextOf(snapshot, runtime)));
  return EXIT.ok;
}

/** `verify`: the caller's verifying tasks, oldest first, each with its proof and the date to verify by. */
export async function verify(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { own } = await settle(runtime, await ownRegister(runtime), () => false);
  const owner = sessionIdOf(own.roster, callerOf(args.flags, runtime.env));
  const queue = verifyQueue(own.snapshot.state.tasks.values(), owner);
  runtime.out.stdout(`VERIFY ${queue.length} ${queue.length === 1 ? 'task' : 'tasks'} of ${owner}, oldest first`);
  queue.forEach((task) => runtime.out.stdout(formatVerifyRow(task)));
  return EXIT.ok;
}

/** The `--week` given, else the newest week plan that has started. */
function weekFor(args: ParsedArgs, snapshot: RegisterSnapshot, now: Date): string | null {
  const week = args.flags.get('week');
  return week === undefined ? currentWeekOf(snapshot, now) : weekOf(week);
}

/** The task flags of one register; with `team`, for `check --tree`, its task ids name it. */
function checkRegister(snapshot: RegisterSnapshot, config: KitConfig, now: Date, week: string | null, team?: string): CheckSection {
  return { team, flags: checkTasks(snapshot.state.tasks.values(), now, week, config.register), context: waitContext(snapshot.state.tasks, now) };
}

/**
 * The week's fit to the weekly limit over every team read (one account's limit covers them all): what is left of
 * the own team's `budget.targetPct` after the newest status-line reading of the week, which costs one folder read
 * (no transcript is measured). `labelled` names each row's team, for a roll-up.
 */
async function weekFitOf(runtime: CliRuntime, { own, teams }: RollUp, week: string, labelled: boolean): Promise<WeekFit> {
  const { budget } = own.config;
  const now = runtime.clock.now();
  const use = weekUseOf(await readSnapshots(runtime.files, snapshotDirOf(budget, own.paths)), now);
  const rows = teams.flatMap((rolled) => [...rolled.snapshot.state.tasks.values()].map((task) => (labelled ? { task, team: rolled.team } : { task })));
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
 * team's only, as teams on one machine share that folder, and so are the flags on hired sessions (src/hiring/due.ts).
 * The `stopgap T<id>` tags in those skills and in the team's `register.check.stopgapFiles` add a STOPGAP-DONE flag
 * per finished task they name.
 */
export async function checkReport(args: ParsedArgs, runtime: CliRuntime): Promise<CheckReport> {
  const now = new Date(runtime.clock.now());
  const tree = args.switches.has('tree');
  const read = await readRegisters(args, runtime);
  const skillFiles = await new SkillDir(runtime.files, read.own.paths.skills).readAll();
  const tags = [
    ...(await readStopgapTags(runtime.files, await projectFolder(runtime), read.own.config.register.check.stopgapFiles)),
    ...skillFiles.flatMap((skill) => stopgapTags(`${skill.name}/${SKILL_FILE}`, skill.text)),
  ];
  // The task flags are on active tasks, which a compaction never retires; a stopgap tag may name a finished task
  // it retired, so only a tag the own team's working set lacks makes it read that team's whole history.
  const working = read.own.snapshot;
  const { own, teams } = await settle(runtime, read, (_retired, snapshot) => snapshot === working && tags.some((tag) => !snapshot.state.tasks.has(tag.id)));
  const week = weekFor(args, own.snapshot, now);
  const checked = teams.map((rolled) => {
    const section = checkRegister(rolled.snapshot, rolled.config, now, week, tree ? rolled.team : undefined);
    const stopgaps = rolled.team === own.team ? stopgapFlags(tags, rolled.snapshot.state.tasks) : [];
    return { ...section, flags: [...section.flags, ...stopgaps].sort(byFlagKind) };
  });
  const sections = week === null || week !== currentWeekOf(own.snapshot, now) ? checked : withOverLimit(checked, await weekFitOf(runtime, { own, teams }, week, tree));
  const skills = lintSkills(skillFiles, now, own.config);
  const { records } = await new HiringLog(runtime.files, own.paths.hires).read();
  const hires = hireFlags({ hires: activeHires(records), tasks: own.snapshot.state.tasks.values(), config: own.config, now });
  const scope = week === null ? 'no week plan tagged yet, so the week checks are skipped' : `week ${week}`;
  return { sections, scope, skills, skillsDir: own.paths.skills, hires };
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
  const week = weekFor(args, read.own.snapshot, now);
  const settled = await settle(runtime, read, week === null ? () => false : weekMayBeRetired(week));
  if (week === null) {
    throw new RefusedError('no week plan tagged yet; pass --week <YYYY-MM-DD>');
  }
  const fit = week === currentWeekOf(settled.own.snapshot, now) ? fitLines(await weekFitOf(runtime, settled, week, tree)) : [];
  const sections = settled.teams.map((rolled, index) =>
    renderPlan(rolled.snapshot.state.tasks.values(), week, now, rolled.config.register, { team: tree ? rolled.team : undefined, fit: index === 0 ? fit : [] }),
  );
  runtime.out.stdout(sections.join('\n\n'));
  return EXIT.ok;
}
