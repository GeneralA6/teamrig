import { formatAddress } from "../../core/address.js";
import { FileLock } from "../../core/lock.js";
import { checkTasks, currentWeek, formatFlag } from "../../register/check.js";
import { renderPlan } from "../../register/plan.js";
import { RegisterPolicy } from "../../register/policy.js";
import { Register } from "../../register/register.js";
import { JsonlEventLog } from "../../register/store.js";
import { formatTask, formatTaskDetail, selectTasks } from "../../register/views.js";
import { formatSkillFlag, lintSkills } from "../../skills/lint.js";
import { SkillDir } from "../../skills/store.js";
import { noPositionals, onePositional, UsageError } from "../args.js";
import { addInputOf, callerOf, changesOf, listFilterOf, statusInputOf, taskIdOf, weekOf } from "../inputs.js";
import { findTeam, openKit, openTeamKit, pastOrPresentIdOf, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { rollUp } from "../roll-up.js";
import { EXIT, RefusedError } from "../runtime.js";
import { loadTree } from "../tree.js";
import { markBoundary } from "./refresh.js";
async function teamOf(runtime, kit, access) {
    const config = requireConfig(kit, runtime, access);
    const { files, clock, sleep, pid } = runtime;
    const register = new Register({
        log: new JsonlEventLog(files, kit.paths.events),
        mutex: new FileLock(kit.paths.eventsLock, config.lock, { files, clock, sleep, pid }),
        clock,
        policy: new RegisterPolicy(config),
        skills: new SkillDir(files, kit.paths.skills),
    });
    return { config, paths: kit.paths, register, roster: await rosterOf(runtime, kit, config) };
}
async function openTeam(runtime, access) {
    return teamOf(runtime, await openTeamKit(runtime), access);
}
/** The owner as an id; a source naming a session becomes its id, the owner's marker or a past session's id stays. */
function addInputIds(team, input) {
    const source = input.source === team.config.register.ownerSource ? input.source : pastOrPresentIdOf(team.roster, input.source);
    return { ...input, owner: sessionIdOf(team.roster, input.owner), source };
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
/** The written task's line; `team` names another team's register, so its id reads `<team>/T12`. */
function report(runtime, verdict, verb, team) {
    if (!verdict.ok) {
        throw new RefusedError(verdict.error);
    }
    runtime.out.stdout(`${verb} ${formatTask(verdict.value.task, team)}`);
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
async function readTeam(runtime) {
    const team = await openTeam(runtime, 'read');
    const snapshot = await team.register.snapshot();
    warnDamage(runtime, snapshot, team.paths.events);
    return { team, snapshot };
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
    return report(runtime, await target.register.addFromParent(formatAddress(from), input), 'ADDED', child);
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
    return report(runtime, await team.register.add(by, addInputIds(team, input)), 'ADDED');
}
export async function set(args, runtime) {
    const id = taskIdOf(onePositional(args, 'id'));
    const caller = callerOf(args.flags, runtime.env);
    const input = statusInputOf(args.flags);
    const { config, paths, register, roster } = await openTeam(runtime, 'write');
    const by = sessionIdOf(roster, caller);
    const exit = report(runtime, await register.setStatus(by, id, input), 'SET');
    if (input.status === 'done') {
        await markBoundary(runtime, config, paths, by, id);
    }
    return exit;
}
export async function update(args, runtime) {
    const id = taskIdOf(onePositional(args, 'id'));
    const caller = callerOf(args.flags, runtime.env);
    const changes = changesOf(args.flags);
    const { register, roster } = await openTeam(runtime, 'write');
    const by = sessionIdOf(roster, caller);
    return report(runtime, await register.update(by, id, changeIds(roster, changes), args.flags.get('note')), 'UPDATED');
}
/** A filter for one team of a roll-up: a source that names one of its sessions becomes its id. */
function treeFilterOf(roster, filter) {
    const found = filter.source === undefined ? undefined : roster.lookup(filter.source);
    return found?.ok === true ? { ...filter, source: found.id } : filter;
}
/** The caller's own register, as a roll-up of one team. */
async function ownRegister(runtime) {
    const { team, snapshot } = await readTeam(runtime);
    const own = { team: team.paths.team, config: team.config, paths: team.paths, roster: team.roster, snapshot };
    return { own, teams: [own] };
}
/** The registers of `--tree`, each naming its damaged lines like a one-team read. */
async function treeRegisters(args, runtime) {
    const rolled = await rollUp(runtime, callerOf(args.flags, runtime.env));
    rolled.teams.forEach(({ snapshot, paths }) => warnDamage(runtime, snapshot, paths.events));
    return rolled;
}
/**
 * `list --tree`: the lead's team and every team under it, ids read `<team>/T12`. As in `check` and
 * `plan`, `--session` (else `$TEAMRIG_SESSION`) names the caller, never an owner to filter: each team
 * has its own sessions, so a roll-up has no one owner. A setup tab, which has no `$TEAMRIG_SESSION`,
 * reads its tree this way.
 */
async function listTree(args, runtime) {
    const filter = listFilterOf(new Map([...args.flags].filter(([name]) => name !== 'session')));
    const { teams } = await treeRegisters(args, runtime);
    for (const { team, roster, snapshot } of teams) {
        selectTasks(snapshot.state.tasks.values(), treeFilterOf(roster, filter)).forEach((task) => runtime.out.stdout(formatTask(task, team)));
    }
    return EXIT.ok;
}
export async function list(args, runtime) {
    noPositionals(args);
    if (args.switches.has('tree')) {
        return listTree(args, runtime);
    }
    const filter = listFilterOf(args.flags);
    const { team, snapshot } = await readTeam(runtime);
    for (const task of selectTasks(snapshot.state.tasks.values(), filterIds(team.roster, filter))) {
        runtime.out.stdout(formatTask(task));
    }
    return EXIT.ok;
}
export async function show(args, runtime) {
    const id = taskIdOf(onePositional(args, 'id'));
    const { snapshot } = await readTeam(runtime);
    const task = snapshot.state.tasks.get(id);
    if (task === undefined) {
        throw new RefusedError(`no task ${id}`);
    }
    runtime.out.stdout(formatTaskDetail(task, snapshot.read.events.filter((event) => event.id === id)));
    return EXIT.ok;
}
/** The `--week` given, else the newest week plan that has started. */
function weekFor(args, snapshot, now) {
    const week = args.flags.get('week');
    return week === undefined ? currentWeek(snapshot.state.tasks.values(), now) : weekOf(week);
}
/** The task flags of one register; with `team`, for `check --tree`, the heading and task ids name it. */
function checkRegister(runtime, snapshot, config, now, week, team) {
    const flags = checkTasks(snapshot.state.tasks.values(), now, week, config.register);
    const scope = week === null ? 'no week plan tagged yet, so the week checks are skipped' : `week ${week}`;
    runtime.out.stdout(`CHECK${team === undefined ? '' : ` ${team}:`} ${flags.length} flag(s), ${scope}`);
    flags.forEach((flag) => runtime.out.stdout(formatFlag(flag, team)));
}
/**
 * `check [--tree]`: the task flags, then the skill flags of the Claude Code skills folder. With
 * `--tree`, the task flags of the lead's team and each team under it, against the lead's week; the
 * skills are the lead's team's only, as teams on one machine share that folder.
 */
export async function check(args, runtime) {
    noPositionals(args);
    const now = new Date(runtime.clock.now());
    const tree = args.switches.has('tree');
    const { own, teams } = tree ? await treeRegisters(args, runtime) : await ownRegister(runtime);
    const week = weekFor(args, own.snapshot, now);
    for (const rolled of teams) {
        checkRegister(runtime, rolled.snapshot, rolled.config, now, week, tree ? rolled.team : undefined);
    }
    const skills = lintSkills(await new SkillDir(runtime.files, own.paths.skills).readAll(), now, own.config);
    runtime.out.stdout(`SKILLS ${skills.length} flag(s) in ${own.paths.skills}`);
    skills.forEach((flag) => runtime.out.stdout(formatSkillFlag(flag)));
    return EXIT.ok;
}
/** `plan [--tree]`: with `--tree`, one section per team, the lead's team first, for the lead's week. */
export async function plan(args, runtime) {
    noPositionals(args);
    const now = new Date(runtime.clock.now());
    const tree = args.switches.has('tree');
    const { own, teams } = tree ? await treeRegisters(args, runtime) : await ownRegister(runtime);
    const week = weekFor(args, own.snapshot, now);
    if (week === null) {
        throw new RefusedError('no week plan tagged yet; pass --week <YYYY-MM-DD>');
    }
    const sections = teams.map((rolled) => renderPlan(rolled.snapshot.state.tasks.values(), week, now, rolled.config.register, tree ? rolled.team : undefined));
    runtime.out.stdout(sections.join('\n\n'));
    return EXIT.ok;
}
