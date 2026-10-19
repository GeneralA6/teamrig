import { formatAddress } from "../../core/address.js";
import { JsonlDailyLog } from "../../core/daily-log.js";
import { SecretScanner } from "../../core/secrets.js";
import { burstsOver, surplusOf } from "../../budget/burst.js";
import { hireFlags } from "../../hiring/due.js";
import { activeHires, HiringLog } from "../../hiring/log.js";
import { scaleOutFlags } from "../../hiring/scale-out.js";
import { postLine } from "../../inbox/inbox.js";
import { readSnapshots, weekUseOf } from "../../budget/snapshot.js";
import { byFlagKind, checkTasks, currentWeekOf, peerWaitFlags } from "../../register/check.js";
import { fitLines, leftOfWeek, overLimitFlag, weekFit } from "../../register/fit.js";
import { renderPlan } from "../../register/plan.js";
import { ACTIVE_STATUSES } from "../../register/model.js";
import { readStopgapTags, stopgapFlags, stopgapTags } from "../../register/stopgap.js";
import { heldStart, heldStartNotice, metStartNotice, startHolds, verifyQueue } from "../../register/verify.js";
import { TaskTree } from "../../register/tree.js";
import { assignedNotice, formatTask, formatTaskDetail, formatTaskTree, formatVerifyRow, personWaitNotice, selectTasks } from "../../register/views.js";
import { isPeerWait, sameWait } from "../../register/waits.js";
import { lintSkills } from "../../skills/lint.js";
import { SKILL_FILE, SkillDir } from "../../skills/store.js";
import { noPositionals, onePositional, UsageError } from "../args.js";
import { addInputOf, callerOf, changesOf, listFilterOf, setInputOf, taskIdOf, weekOf } from "../inputs.js";
import { findTeam, openKit, openTeamKit, pastOrPresentIdOf, projectFolder, requireConfig, rosterOf, sessionIdOf, teamZone } from "../kit.js";
import { checkLines, listLines, SHORT_TITLE_CHARS, waitingOnLines } from "../reports.js";
import { rollUp } from "../roll-up.js";
import { EXIT, RefusedError } from "../runtime.js";
import { loadTree } from "../tree.js";
import { teamRegister } from "../team-register.js";
import { readBursts } from "../burst-reading.js";
import { readHirePct } from "../hire-cost.js";
import { snapshotDirOf } from "./budget.js";
import { inboxDepsOf } from "./inbox.js";
import { markBoundary } from "./refresh.js";
import { markKeepWorkingAsk } from "./keep-working.js";
import { markRetireAsk } from "./retire-ask.js";
/** What a time the caller types is read against: this moment and the zone of the caller's own team. */
function typedTimes(runtime, zone) {
    return { nowMs: runtime.clock.now(), zone };
}
async function teamOf(runtime, kit, access) {
    const config = requireConfig(kit, runtime, access);
    return { config, paths: kit.paths, register: teamRegister(runtime, kit.paths, config), roster: await rosterOf(runtime, kit, config), zone: teamZone(config, runtime) };
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
 * The written task's line, its times in the zone of `written`, the team whose register was written; `label` names
 * another team's register, so its id reads `<label>/T12`. A rotation the write ran is named on stderr, so the task
 * line stays the one line a script reads, with the switch that turns it off in the written team's config.
 */
function report(runtime, verdict, verb, written, label) {
    if (!verdict.ok) {
        throw new RefusedError(verdict.error);
    }
    const { task, state } = verdict.value;
    runtime.out.stdout(`${verb} ${formatTask(task, label, new TaskTree(state.tasks, new Date(runtime.clock.now()), written.zone))}`);
    const { rotation } = verdict.value;
    const turnOff = autoArchiveSwitch(written.paths.config);
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
    const input = { ...addInputOf(args.flags, caller, typedTimes(runtime, teamZone(config, runtime))), owner: childLead, source: formatAddress(from) };
    return report(runtime, await target.register.addFromParent(formatAddress(from), input), 'ADDED', target, child);
}
export async function add(args, runtime) {
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
    await tellNewOwner(runtime, team, by, verdict);
    return code;
}
/**
 * One inbox line to the task's owner when this write gave it the task (`add --owner`, `update --owner`), so asking
 * for work is one command; never to the caller, who gave it. A line that cannot be posted is named, never thrown:
 * the task is written either way.
 */
async function tellNewOwner(runtime, team, by, verdict) {
    if (!verdict.ok) {
        return;
    }
    const { task, before } = verdict.value;
    if (task.owner === by || task.owner === before?.owner) {
        return;
    }
    await tellAssigned(runtime, team, by, task);
}
/** One inbox line telling a task's owner the task is its own. */
async function tellAssigned(runtime, team, by, task) {
    await tellLine(runtime, team, by, task.owner, assignedNotice(task, team.zone), `${task.owner} was not told of ${task.id}`);
}
/**
 * One inbox line to the lead when a write set a task waiting on a decision or an approval of the lead's or the
 * owner's that it did not wait on before (the lead keeps the owner's decision queue); never when the lead set it.
 */
async function tellLeadOfWaits(runtime, team, by, verdict) {
    const { lead } = team.config.roles;
    if (!verdict.ok || by === lead) {
        return;
    }
    const { task, before } = verdict.value;
    const earlier = before?.status === 'waiting' ? before.waits : [];
    const added = task.waits.filter((reason) => (reason.kind === 'decision' || reason.kind === 'approval') &&
        !isPeerWait(reason, lead, team.config.register.ownerSource) &&
        !earlier.some((other) => sameWait(reason, other)));
    if (task.status === 'waiting' && added.length > 0) {
        await tellLine(runtime, team, by, lead, personWaitNotice(task, added, lead), `${lead} was not told that ${task.id} waits on it`);
    }
}
/** Posts one inbox line, naming it on stderr, or naming `unsent` and why: a line that cannot be posted is never thrown. */
async function tellLine(runtime, team, by, to, text, unsent) {
    const { inboxes } = inboxDepsOf(runtime, team.paths);
    const secrets = new SecretScanner(team.config.register.secretPatterns);
    const problem = await postLine(inboxes, secrets, { to, from: by, text, now: new Date(runtime.clock.now()) });
    runtime.out.stderr(problem === undefined ? `NOTE ${to} has an inbox line: ${text}` : `WARN ${unsent}: ${problem}`);
}
export async function set(args, runtime) {
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
    const held = await heldStartOf(register, by, id, input);
    const verdict = await register.setStatus(by, id, input);
    const warned = config.register.verifyGate === 'warn';
    // The start as written: one that named its held proof as met asks the verifying owners to confirm it.
    const met = verdict.ok && verdict.value.event.type === 'status' ? (verdict.value.event.met ?? null) : null;
    if (held !== undefined && (verdict.ok || !warned)) {
        await tellVerifiers(runtime, team, by, held, met);
    }
    const exit = report(runtime, verdict, 'SET', team);
    await tellLeadOfWaits(runtime, team, by, verdict);
    if (held !== undefined && warned && verdict.ok && met === null) {
        runtime.out.stderr(`WARN ${heldStart(held.task, held.holds)}; started anyway, as register.verifyGate is warn`);
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
async function setAsking(runtime, team, by, id, ask, input) {
    const verdict = await team.register.ask(by, id, ask, input);
    if (verdict.ok) {
        const { asked, state } = verdict.value;
        runtime.out.stdout(`ADDED ${formatTask(asked, undefined, new TaskTree(state.tasks, new Date(runtime.clock.now()), team.zone))}`);
    }
    const exit = report(runtime, verdict, 'SET', team);
    if (verdict.ok && verdict.value.asked.owner !== by) {
        await tellAssigned(runtime, team, by, verdict.value.asked);
    }
    await tellLeadOfWaits(runtime, team, by, verdict);
    if (verdict.ok) {
        await markKeepWorkingAsk(runtime, team.paths, verdict.value);
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
 * day, never to the caller, who reads the refusal: that the start waits, or, for a start that went
 * through with `--met`, what met the proof, to confirm or reopen. A line that cannot be posted is named, never thrown.
 */
async function tellVerifiers(runtime, team, caller, { task, holds }, met) {
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
        }
        else {
            runtime.out.stderr(`WARN ${held.owner} was not told of ${task.id}: ${problem}`);
        }
    }
}
export async function update(args, runtime) {
    const id = taskIdOf(onePositional(args, 'id'));
    const caller = callerOf(args.flags, runtime.env);
    const team = await openTeam(runtime, 'write');
    const changes = changesOf(args.flags, typedTimes(runtime, team.zone));
    const by = sessionIdOf(team.roster, caller);
    const verdict = await team.register.update(by, id, changeIds(team.roster, changes), args.flags.get('note'));
    const code = report(runtime, verdict, 'UPDATED', team);
    await tellNewOwner(runtime, team, by, verdict);
    return code;
}
/** A filter for one team of a roll-up: a source that names one of its sessions becomes its id. */
function treeFilterOf(roster, filter) {
    const found = filter.source === undefined ? undefined : roster.lookup(filter.source);
    return found?.ok === true ? { ...filter, source: found.id } : filter;
}
/** The caller's own register, as a roll-up of one team. */
export async function ownRegister(runtime) {
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
/** The dependency tree of one team's register read now, in its zone: ready wait reasons, effective dues and what needs each task. */
function taskTreeOf({ snapshot, config }, runtime) {
    return new TaskTree(snapshot.state.tasks, new Date(runtime.clock.now()), teamZone(config, runtime));
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
    const up = await rollUp(runtime, callerOf(args.flags, runtime.env));
    const filter = listFilterOf(new Map([...args.flags].filter(([name]) => name !== 'session')), typedTimes(runtime, teamZone(up.own.config, runtime)));
    const { teams } = await settle(runtime, up, selectsFinished(filter));
    return teams.flatMap((rolled) => {
        const { team, roster, snapshot } = rolled;
        const tree = taskTreeOf(rolled, runtime);
        return selectTasks(snapshot.state.tasks.values(), treeFilterOf(roster, filter), tree).map((task) => ({ task, team, tree }));
    });
}
async function ownRows(args, runtime) {
    const up = await ownRegister(runtime);
    const filter = listFilterOf(args.flags, typedTimes(runtime, teamZone(up.own.config, runtime)));
    const { own } = await settle(runtime, up, selectsFinished(filter));
    const tree = taskTreeOf(own, runtime);
    return selectTasks(own.snapshot.state.tasks.values(), filterIds(own.roster, filter), tree).map((task) => ({ task, team: undefined, tree }));
}
/** `list [--tree] [--all]`: the short form (src/cli/reports.ts), or with `--all` every field of every task. */
export async function list(args, runtime) {
    noPositionals(args);
    const rows = args.switches.has('tree') ? await treeRows(args, runtime) : await ownRows(args, runtime);
    listLines(rows, args.switches.has('all')).forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
/**
 * `show <id> [--tree]`: every field of the task and its history; with `--tree`, its line, then what it needs and what
 * needs it, each node with its owner, status and due, then who moves next (views.ts formatTaskTree).
 */
export async function show(args, runtime) {
    const id = taskIdOf(onePositional(args, 'id'));
    const { own } = await settle(runtime, await ownRegister(runtime), (_retired, working) => !working.state.tasks.has(id));
    const { snapshot } = own;
    const task = snapshot.state.tasks.get(id);
    if (task === undefined) {
        throw new RefusedError(`no task ${id}`);
    }
    const tree = taskTreeOf(own, runtime);
    if (args.switches.has('tree')) {
        [formatTask(task, undefined, tree), ...formatTaskTree(task, tree, SHORT_TITLE_CHARS)].forEach((line) => runtime.out.stdout(line));
        return EXIT.ok;
    }
    runtime.out.stdout(formatTaskDetail(task, snapshot.read.events.filter((event) => event.id === id), tree));
    return EXIT.ok;
}
/**
 * `start`'s WAITING ON YOU block: the active tasks of other sessions that need the caller's unfinished tasks or wait
 * on its decision or approval, from the working set (a finished task waits on no one); `--all` lists every one.
 */
export async function waitingReport(args, runtime) {
    const { own } = await settle(runtime, await ownRegister(runtime), () => false);
    const owner = sessionIdOf(own.roster, callerOf(args.flags, runtime.env));
    const tree = taskTreeOf(own, runtime);
    return waitingOnLines(owner, tree.waitingOn(owner), tree, args.switches.has('all'));
}
/** `verify`: the caller's verifying tasks, oldest first, each with its proof and the date to verify by. */
export async function verify(args, runtime) {
    noPositionals(args);
    const { own } = await settle(runtime, await ownRegister(runtime), () => false);
    const owner = sessionIdOf(own.roster, callerOf(args.flags, runtime.env));
    const queue = verifyQueue(own.snapshot.state.tasks.values(), owner);
    runtime.out.stdout(`VERIFY ${queue.length} ${queue.length === 1 ? 'task' : 'tasks'} of ${owner}, oldest first`);
    queue.forEach((task) => runtime.out.stdout(formatVerifyRow(task, teamZone(own.config, runtime))));
    return EXIT.ok;
}
/** The `--week` given, else the newest week plan that has started in the team's `zone`. */
function weekFor(args, snapshot, now, zone) {
    const week = args.flags.get('week');
    return week === undefined ? currentWeekOf(snapshot, now, zone) : weekOf(week);
}
/**
 * The task flags of one register, against its own team's config and in its `zone`; with `team`, for `check --tree`,
 * its task ids name it.
 */
function checkRegister(snapshot, config, now, zone, week, team) {
    const tasks = [...snapshot.state.tasks.values()];
    const flags = [...checkTasks(tasks, now, zone, week, config.register), ...peerWaitFlags(tasks, config.roles.lead, config.register.ownerSource)];
    return { team, flags: flags.sort(byFlagKind), tree: new TaskTree(snapshot.state.tasks, now, zone) };
}
/**
 * The week's fit to the weekly limit over every team read (one account's limit covers them all): what is left of
 * the own team's `budget.targetPct` after the newest status-line reading of the week, which costs one folder read
 * (no transcript is measured). `labelled` names each row's team, for a roll-up. `plan`, `check` and the meeting
 * agenda (meeting.ts) read it.
 */
export async function weekFitOf(runtime, { own, teams }, week, labelled) {
    const { budget } = own.config;
    const now = runtime.clock.now();
    const use = weekUseOf(await readSnapshots(runtime.files, snapshotDirOf(budget, own.paths)), now);
    const rows = teams.flatMap((rolled) => {
        const tree = new TaskTree(rolled.snapshot.state.tasks, new Date(now), teamZone(rolled.config, runtime));
        return [...rolled.snapshot.state.tasks.values()].map((task) => (labelled ? { task, tree, team: rolled.team } : { task, tree }));
    });
    return weekFit(rows, week, use === undefined ? undefined : leftOfWeek(budget.targetPct, use.usedPct));
}
/** OVER-LIMIT goes to the section of the team holding the task: the only one without `--tree`. */
function withOverLimit(sections, fit) {
    const flag = overLimitFlag(fit);
    return sections.map((section) => flag !== undefined && section.team === fit.unfit?.row.team ? { ...section, flags: [...section.flags, flag].sort(byFlagKind) } : section);
}
/**
 * What `check` reports: the task flags, then the skill flags of the Claude Code skills folder. With `--tree`,
 * the task flags of the lead's team and each team under it, against the lead's week; the skills are the lead's
 * team's only, as teams on one machine share that folder, and so are the flags on hired sessions (src/hiring/due.ts).
 * The `stopgap T<id>` tags in those skills and in the team's `register.check.stopgapFiles` add a STOPGAP-DONE flag
 * per finished task they name.
 */
export async function checkReport(args, runtime) {
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
    const zone = teamZone(own.config, runtime);
    const week = weekFor(args, own.snapshot, now, zone);
    const checked = teams.map((rolled) => {
        const section = checkRegister(rolled.snapshot, rolled.config, now, teamZone(rolled.config, runtime), week, tree ? rolled.team : undefined);
        const stopgaps = rolled.team === own.team ? stopgapFlags(tags, rolled.snapshot.state.tasks, zone) : [];
        return { ...section, flags: [...section.flags, ...stopgaps].sort(byFlagKind) };
    });
    const sections = week === null || week !== currentWeekOf(own.snapshot, now, zone) ? checked : withOverLimit(checked, await weekFitOf(runtime, { own, teams }, week, tree));
    const skills = lintSkills(skillFiles, now, own.config);
    const { records } = await new HiringLog(runtime.files, own.paths.hires).read();
    const bursts = await readBursts(runtime, own.paths, own.config.budget, now.getTime());
    const over = burstsOver(bursts.records, now.getTime(), bursts.usedPct);
    const { usedPct, window } = bursts;
    const spare = usedPct === undefined || window === undefined ? undefined : surplusOf({ window, now: now.getTime(), usedPct, targetPct: own.config.budget.targetPct, config: own.config.burst });
    const tasks = [...own.snapshot.state.tasks.values()];
    const hirePct = spare === undefined ? undefined : await readHirePct(runtime, own.paths, own.config, tasks, now.getTime());
    const input = { hires: activeHires(records), tasks, config: own.config, burstsOver: over, now };
    const scaleOut = scaleOutFlags({ ...input, tree: new TaskTree(own.snapshot.state.tasks, now, zone), spare, hirePct });
    const hires = [...scaleOut.flags, ...hireFlags(input, scaleOut.busy)];
    const scope = week === null ? 'no week plan tagged yet, so the week checks are skipped' : `week ${week}`;
    return { sections, scope, skills, skillsDir: own.paths.skills, hires };
}
/** `check [--tree] [--all]`: the report in the short form (src/cli/reports.ts), or with `--all` every flag in full. */
export async function check(args, runtime) {
    noPositionals(args);
    checkLines(await checkReport(args, runtime), args.switches.has('all')).forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
/**
 * `plan [--tree]`: with `--tree`, one section per team, the lead's team first, for the lead's week. The week's fit
 * to the weekly limit sits under the first section's counts, for the week in force only (the limit read is this
 * week's): with `--tree`, one fit over every team shown.
 */
export async function plan(args, runtime) {
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
    const sections = settled.teams.map((rolled, index) => renderPlan(rolled.snapshot.state.tasks.values(), week, now, teamZone(rolled.config, runtime), rolled.config.register, { team: tree ? rolled.team : undefined, fit: index === 0 ? fit : [] }));
    runtime.out.stdout(sections.join('\n\n'));
    return EXIT.ok;
}
