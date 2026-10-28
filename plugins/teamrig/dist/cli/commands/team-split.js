import { relative } from 'node:path';
import { formatConfig } from "../../config/load.js";
import { claudeConfigDir, resolveKitHome, teamPaths } from "../../core/home.js";
import { InboxDir } from "../../inbox/store.js";
import { JsonlRenameLog } from "../../names/log.js";
import { TASK_STATUSES } from "../../register/model.js";
import { sessionFilesOf } from "../../setup/session-files.js";
import { teamSpecOf } from "../../setup/team-create.js";
import { planTeamSplit } from "../../setup/team-split.js";
import { onePositional, requiredFlag, UsageError } from "../args.js";
import { callerOf, listOf } from "../inputs.js";
import { configFileJson, leadOnly, openTeamKit, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { teamRegister } from "../team-register.js";
import { loadTree } from "../tree.js";
import { warnDamage } from "./register.js";
import { blockerText, liveSessionsOf, liveText, writeTeamSplit } from "./team-split-write.js";
async function sessionsLeftOf(runtime, paths, ids) {
    const inbox = new InboxDir(runtime.files, paths.inbox);
    const { renames } = await new JsonlRenameLog(runtime.files, paths.renames).read();
    const left = [];
    for (const id of ids) {
        const files = [];
        for (const path of sessionFilesOf(paths, id)) {
            if ((await runtime.probe.kind(path)) !== 'none') {
                files.push(relative(paths.home, path));
            }
        }
        left.push({ id, inboxLines: (await inbox.lines(id))?.length ?? 0, files, renames: renames.filter((rename) => rename.id === id).length });
    }
    return left;
}
/** `<id> (<name>)`, the way the plan names a session. */
function named(roster, id) {
    return `${id} (${roster.nameOf(id) ?? id})`;
}
/** The moving tasks of one owner, counted by status in the register's status order. */
function statusCounts(plan, owner) {
    const owned = plan.moving.filter((task) => task.owner === owner);
    return TASK_STATUSES.flatMap((status) => {
        const count = owned.filter((task) => task.status === status).length;
        return count === 0 ? [] : [`${count} ${status}`];
    }).join(', ');
}
function planLines(plan, parent, roster, configPaths, left, live) {
    const { spec, trim } = plan;
    const sideOf = (moves) => (moves ? spec.team : parent);
    return [
        'DRY RUN nothing is written',
        `TEAM ${spec.team} under ${parent}: lead ${named(roster, spec.lead)}; sessions ${spec.sessions.map((id) => named(roster, id)).join(', ')}`,
        `WOULD CREATE ${configPaths.child}:`,
        ...formatConfig(plan.config).trimEnd().split('\n'),
        `PARENT ${configPaths.parent} loses sessions ${spec.sessions.join(', ')}${trim.keys.length === 0 ? '' : ` and keys ${trim.keys.join(', ')}`}`,
        ...(plan.leftOut.length === 0 ? [] : [`LEFT OUT ${plan.leftOut.join(', ')}: the child starts without them`]),
        ...trim.leftLeads.map(({ lead, id }) => `SUB-LEAD ${lead}'s list loses ${id}, which moves`),
        ...trim.unled.map(({ lead, id }) => `UNLED ${id}: its sub-lead ${lead} moves, so the lead leads it`),
        `TASKS ${plan.moving.length} move to ${spec.team}, ${plan.staying} stay in ${parent}`,
        ...spec.sessions.flatMap((id) => {
            const counts = statusCounts(plan, id);
            return counts === '' ? [] : [`  ${id}: ${counts}`];
        }),
        ...plan.links.map((link) => {
            const relation = link.kind === 'after' ? 'runs after' : 'waits on';
            return `LINK ${link.task} in ${sideOf(link.taskMoves)} ${relation} ${link.on} in ${sideOf(!link.taskMoves)}`;
        }),
        ...plan.rewrites.map((rewrite) => `REWRITE ${rewrite.task} ${rewrite.field} ${rewrite.from} -> ${rewrite.to}`),
        ...plan.blockers.map(blockerText).map((text) => `BLOCKED ${text}`),
        ...live.map(liveText).map((text) => `BLOCKED ${text}`),
        ...left.flatMap((session) => [
            ...(session.inboxLines === 0 ? [] : [`INBOX ${session.id}: ${session.inboxLines} line(s) move`]),
            ...(session.files.length === 0 ? [] : [`FILES ${session.id}: ${session.files.join(', ')}`]),
            ...(session.renames === 0 ? [] : [`RENAMES ${session.id}: ${session.renames} rename line(s) move`]),
        ]),
    ];
}
export async function teamSplit(args, runtime) {
    const child = onePositional(args, 'team');
    const dryRun = args.switches.has('dry-run');
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, dryRun ? 'read' : 'write');
    const roster = await rosterOf(runtime, kit, config);
    const by = leadOnly(roster, callerOf(args.flags, runtime.env), 'splits the team');
    const lead = sessionIdOf(roster, requiredFlag(args.flags, 'lead'));
    const sessions = listOf('--sessions', requiredFlag(args.flags, 'sessions')).map((each) => sessionIdOf(roster, each));
    const spec = teamSpecOf(child, sessions.join(','), lead, kit.paths.team);
    if (!spec.ok) {
        throw new UsageError(spec.problem);
    }
    const childPaths = teamPaths(resolveKitHome(runtime.env, runtime.userHome), child, claudeConfigDir(runtime.env, runtime.userHome));
    if ((await runtime.probe.kind(childPaths.home)) !== 'none') {
        throw new RefusedError(`${childPaths.home} exists already; a split makes a new team`);
    }
    const snapshot = await teamRegister(runtime, kit.paths, config).snapshot();
    warnDamage(runtime, snapshot, kit.paths.events);
    const record = await configFileJson(runtime, kit.load.path);
    const current = kit.load.status === 'loaded' ? (kit.load.pending?.migrated ?? record) : record;
    const parent = { team: kit.paths.team, config, record, current, paths: kit.paths, roster };
    const planned = planTeamSplit(parent, spec.value, (await loadTree(runtime)).tree, snapshot.state.tasks);
    if (!planned.ok) {
        throw new RefusedError(planned.problem);
    }
    if (!dryRun) {
        return writeTeamSplit({ runtime, kit, config, record: parent.record, by, plan: planned.value, childPaths });
    }
    const left = await sessionsLeftOf(runtime, kit.paths, spec.value.sessions);
    const live = await liveSessionsOf(runtime, kit.paths, spec.value.sessions);
    planLines(planned.value, kit.paths.team, roster, { child: childPaths.config, parent: kit.load.path }, left, live).forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
