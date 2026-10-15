import { formatAddress } from "../../core/address.js";
import { JsonlDailyLog } from "../../core/daily-log.js";
import { SecretScanner } from "../../core/secrets.js";
import { postLine } from "../../inbox/inbox.js";
import { checkTasks, currentWeekOf } from "../../register/check.js";
import { renderPlan } from "../../register/plan.js";
import { ACTIVE_STATUSES } from "../../register/model.js";
import { heldStart, heldStartNotice, startHolds, verifyQueue } from "../../register/verify.js";
import { formatTask, formatTaskDetail, formatVerifyRow, selectTasks } from "../../register/views.js";
import { waitContext } from "../../register/waits.js";
import { lintSkills } from "../../skills/lint.js";
import { SkillDir } from "../../skills/store.js";
import { noPositionals, onePositional, UsageError } from "../args.js";
import { addInputOf, callerOf, changesOf, listFilterOf, statusInputOf, taskIdOf, weekOf } from "../inputs.js";
import { findTeam, openKit, openTeamKit, pastOrPresentIdOf, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { checkLines, listLines } from "../reports.js";
import { rollUp } from "../roll-up.js";
import { EXIT, RefusedError } from "../runtime.js";
import { loadTree } from "../tree.js";
import { teamRegister } from "../team-register.js";
import { inboxDepsOf } from "./inbox.js";
import { markBoundary } from "./refresh.js";
async function teamOf(runtime, kit, access) {
    const config = requireConfig(kit, runtime, access);
    return { config, paths: kit.paths, register: teamRegister(runtime, kit.paths, config), roster: await rosterOf(runtime, kit, config) };
}
async function openTeam(runtime, access) {
    return teamOf(runtime, await openTeamKit(runtime), access);
}
/** The owner as an id; a source naming a session becomes its id, the owner's marker or a past session's id stays. */
function addInputIds(team, input) {
    const source = input.source === team.config.register.ownerSource ? input.source : pastOrPresentIdOf(team.roster, input.source);
    return { ...input, owner: sessionIdOf(team.roster, input.owner), source };
}
/** Who a decision or an approval waits for, as an id: a session's name becomes its id, the owner's marker stays. */
function statusInputIds(team, input) {
    if (input.waits === undefined) {
        return input;
    }
    const { ownerSource } = team.config.register;
    const waits = input.waits.map((reason) => (reason.kind === 'decision' || reason.kind === 'approval') && reason.who !== ownerSource
        ? { kind: reason.kind, who: sessionIdOf(team.roster, reason.who) }
        : reason);
    return { ...input, waits };
}
function changeIds(roster, changes) {
    return changes.owner === undefined ? changes : { ...changes, owner: sessionIdOf(roster, changes.owner) };
}
function filterIds(roster, filter) {
    return {
        ...filter,
        ...(filter.owner === undefined ? {} : { owner: pastOrPresentIdOf(roster, filter.owner) }),
        ...(filter.source === undefined ? {} : { source: pastOrPresentIdOf(roster, filter.source) }),
    };
}
/** How a line about automatic archiving names its switch: the key, and the config file that holds it. */
function autoArchiveSwitch(configPath) {
    return `turn automatic archiving off with register.autoArchive: false in ${configPath}`;
}
/**
 * The written task's line; `team` names another team's register, so its id reads `<team>/T12`. A rotation
 * the write ran is named on stderr, so the task line stays the one line a script reads, with the switch
 * that turns it off in `configPath`, the config of the team whose register was written.
 */
function report(runtime, verdict, verb, configPath, team) {
    if (!verdict.ok) {
        throw new RefusedError(verdict.error);
    }
    const { task, state } = verdict.value;
    runtime.out.stdout(`${verb} ${formatTask(task, team, waitContext(state.tasks, new Date(runtime.clock.now())))}`);
    const { rotation } = verdict.value;
    const turnOff = autoArchiveSwitch(configPath);
    if (rotation.kind === 'rotated') {
        runtime.out.stderr(`NOTE the task list's log is archived as segment ${rotation.segment}; ${rotation.retired} finished task(s) left the working set (${turnOff})`);
    }
    else if (rotation.kind === 'failed') {
        runtime.out.stderr(`WARN the write is saved, but archiving the task list's log failed (the next write tries again; ${turnOff}): ${rotation.error}`);
    }
    return EXIT.ok;
}
/** Damaged or newer lines never stop a read; they are named on stderr so someone fixes them. */
function warnDamage(runtime, snapshot, path) {
    const { unreadable, newer } = snapshot.read;
    const { orphans } = snapshot.state;
    if (unreadable + newer + orphans > 0) {
        runtime.out.stderr(`WARN ${path}: ${unreadable} unreadable line(s), ${newer} line(s) from a newer teamrig, ${orphans} event(s) naming no task`);
    }
}
/**
 * `add --team <child>`: a parent team's lead hands a child team a task. It lands in the child's
 * register as an event by `<parent team>/<lead id>`, which is also its source, owned by the child's
 * lead, who plans it in. Only the child's parent lead may; the parent's register is not touched.
 */
async function addToChild(args, runtime, caller, child) {
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
export async function add(args, runtime) {
    noPositionals(args);
    const caller = callerOf(args.flags, runtime.env);
    const child = args.flags.get('team');
    if (child !== undefined) {
        return addToChild(args, runtime, caller, child);
    }
    const input = addInputOf(args.flags, caller);
    const team = await openTeam(runtime, 'write');
    const by = sessionIdOf(team.roster, caller);
    return report(runtime, await team.register.add(by, addInputIds(team, input)), 'ADDED', team.paths.config);
}
export async function set(args, runtime) {
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
    return exit;
}
/**
 * The verifying tasks that hold the caller's start of its own task, read before the write: the policy
 * refuses that start (or lets it through in warn mode), and their owners hear of it either way.
 */
async function heldStartOf(register, caller, id, input) {
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
async function tellVerifiers(runtime, team, caller, { task, holds }) {
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
        }
        else {
            runtime.out.stderr(`WARN ${held.owner} was not told of ${task.id}: ${problem}`);
        }
    }
}
export async function update(args, runtime) {
    const id = taskIdOf(onePositional(args, 'id'));
    const caller = callerOf(args.flags, runtime.env);
    const changes = changesOf(args.flags);
    const { paths, register, roster } = await openTeam(runtime, 'write');
    const by = sessionIdOf(roster, caller);
    return report(runtime, await register.update(by, id, changeIds(roster, changes), args.flags.get('note')), 'UPDATED', paths.config);
}
/** A filter for one team of a roll-up: a source that names one of its sessions becomes its id. */
function treeFilterOf(roster, filter) {
    const found = filter.source === undefined ? undefined : roster.lookup(filter.source);
    return found?.ok === true ? { ...filter, source: found.id } : filter;
}
/** The caller's own register, as a roll-up of one team. */
async function ownRegister(runtime) {
    const { config, paths, roster, register } = await openTeam(runtime, 'read');
    const own = { team: paths.team, config, paths, roster, snapshot: await register.snapshot(), history: () => register.history() };
    return { own, teams: [own] };
}
/** The registers a command reads: those of `--tree`, else the caller's own. */
async function readRegisters(args, runtime) {
    return args.switches.has('tree') ? rollUp(runtime, callerOf(args.flags, runtime.env)) : ownRegister(runtime);
}
/** Each register as the command needs it, each naming its damaged lines once, as read. */
async function settle(runtime, { own, teams }, needsHistory) {
    const settled = [];
    for (const rolled of teams) {
        const { retired } = rolled.snapshot;
        const snapshot = retired !== null && needsHistory(retired, rolled.snapshot) ? await rolled.history() : rolled.snapshot;
        warnDamage(runtime, snapshot, rolled.paths.events);
        settled.push({ ...rolled, snapshot });
    }
    return { own: settled.find((rolled) => rolled.team === own.team) ?? own, teams: settled };
}
/** How a read of one register judges its waiting tasks' reasons now. */
function contextOf(snapshot, runtime) {
    return waitContext(snapshot.state.tasks, new Date(runtime.clock.now()));
}
/** A filter that selects finished tasks, the only ones a compaction retires. */
function selectsFinished(filter) {
    return () => (filter.statuses ?? ACTIVE_STATUSES).some((status) => !ACTIVE_STATUSES.includes(status));
}
/** A week plan no newer than the newest one among the retired tasks may name some of them. */
function weekMayBeRetired(week) {
    return (retired) => retired.lastWeek !== null && week <= retired.lastWeek;
}
/**
 * `list --tree`: the lead's team and every team under it, ids read `<team>/T12`. As in `check` and
 * `plan`, `--session` (else `$TEAMRIG_SESSION`) names the caller, never an owner to filter: each team
 * has its own sessions, so a roll-up has no one owner. A setup tab, which has no `$TEAMRIG_SESSION`,
 * reads its tree this way.
 */
async function treeRows(args, runtime) {
    const filter = listFilterOf(new Map([...args.flags].filter(([name]) => name !== 'session')));
    const { teams } = await settle(runtime, await rollUp(runtime, callerOf(args.flags, runtime.env)), selectsFinished(filter));
    return teams.flatMap(({ team, roster, snapshot }) => {
        const context = contextOf(snapshot, runtime);
        return selectTasks(snapshot.state.tasks.values(), treeFilterOf(roster, filter)).map((task) => ({ task, team, context }));
    });
}
async function ownRows(args, runtime) {
    const filter = listFilterOf(args.flags);
    const { own } = await settle(runtime, await ownRegister(runtime), selectsFinished(filter));
    const context = contextOf(own.snapshot, runtime);
    return selectTasks(own.snapshot.state.tasks.values(), filterIds(own.roster, filter)).map((task) => ({ task, team: undefined, context }));
}
/** `list [--tree] [--all]`: the short form (src/cli/reports.ts), or with `--all` every field of every task. */
export async function list(args, runtime) {
    noPositionals(args);
    const rows = args.switches.has('tree') ? await treeRows(args, runtime) : await ownRows(args, runtime);
    listLines(rows, args.switches.has('all')).forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
export async function show(args, runtime) {
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
export async function verify(args, runtime) {
    noPositionals(args);
    const { own } = await settle(runtime, await ownRegister(runtime), () => false);
    const owner = sessionIdOf(own.roster, callerOf(args.flags, runtime.env));
    const queue = verifyQueue(own.snapshot.state.tasks.values(), owner);
    runtime.out.stdout(`VERIFY ${queue.length} ${queue.length === 1 ? 'task' : 'tasks'} of ${owner}, oldest first`);
    queue.forEach((task) => runtime.out.stdout(formatVerifyRow(task)));
    return EXIT.ok;
}
/** The `--week` given, else the newest week plan that has started. */
function weekFor(args, snapshot, now) {
    const week = args.flags.get('week');
    return week === undefined ? currentWeekOf(snapshot, now) : weekOf(week);
}
/** The task flags of one register; with `team`, for `check --tree`, its task ids name it. */
function checkRegister(snapshot, config, now, week, team) {
    return { team, flags: checkTasks(snapshot.state.tasks.values(), now, week, config.register), context: waitContext(snapshot.state.tasks, now) };
}
/**
 * `check [--tree] [--all]`: the task flags, then the skill flags of the Claude Code skills folder, in
 * the short form (src/cli/reports.ts), or with `--all` every flag in full. With `--tree`, the task
 * flags of the lead's team and each team under it, against the lead's week; the skills are the lead's
 * team's only, as teams on one machine share that folder.
 */
export async function check(args, runtime) {
    noPositionals(args);
    const now = new Date(runtime.clock.now());
    const tree = args.switches.has('tree');
    // The flags are on active tasks, which a compaction never retires: the working set holds them all.
    const { own, teams } = await settle(runtime, await readRegisters(args, runtime), () => false);
    const week = weekFor(args, own.snapshot, now);
    const sections = teams.map((rolled) => checkRegister(rolled.snapshot, rolled.config, now, week, tree ? rolled.team : undefined));
    const skills = lintSkills(await new SkillDir(runtime.files, own.paths.skills).readAll(), now, own.config);
    const scope = week === null ? 'no week plan tagged yet, so the week checks are skipped' : `week ${week}`;
    const report = { sections, scope, skills, skillsDir: own.paths.skills };
    checkLines(report, args.switches.has('all')).forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
/** `plan [--tree]`: with `--tree`, one section per team, the lead's team first, for the lead's week. */
export async function plan(args, runtime) {
    noPositionals(args);
    const now = new Date(runtime.clock.now());
    const tree = args.switches.has('tree');
    const read = await readRegisters(args, runtime);
    const week = weekFor(args, read.own.snapshot, now);
    const { teams } = await settle(runtime, read, week === null ? () => false : weekMayBeRetired(week));
    if (week === null) {
        throw new RefusedError('no week plan tagged yet; pass --week <YYYY-MM-DD>');
    }
    const sections = teams.map((rolled) => renderPlan(rolled.snapshot.state.tasks.values(), week, now, rolled.config.register, tree ? rolled.team : undefined));
    runtime.out.stdout(sections.join('\n\n'));
    return EXIT.ok;
}
