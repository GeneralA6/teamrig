import { parseConfig } from "../config/parse.js";
import { ANCESTOR_ROLES, Roster } from "../config/roster.js";
import { describeTreeProblem, teamNodeOf } from "../config/tree.js";
import { ADDRESS_PATTERN } from "../core/address.js";
import { recordField } from "../core/guards.js";
import { KIT_NAME } from "../core/home.js";
import { configRecordOf } from "./team-create.js";
function ok(value) {
    return { ok: true, value };
}
function fail(problem) {
    return { ok: false, problem };
}
/** Why the sessions cannot move: one not on the parent, the parent's lead, or the holder of a parent role. */
function sessionProblem(parent, spec) {
    const { team, roster } = parent;
    const unknown = spec.sessions.find((id) => !roster.ids.includes(id));
    if (unknown !== undefined) {
        return `${unknown} is not a session of team ${team} (sessions: ${roster.describe()})`;
    }
    const lead = roster.holderOf('lead');
    if (lead !== undefined && spec.sessions.includes(lead)) {
        return `${lead} leads team ${team}, which keeps its lead; a split moves other sessions`;
    }
    for (const id of spec.sessions) {
        const [role] = roster.rolesOf(id);
        if (role !== undefined) {
            return `${id} is team ${team}'s ${role}; give that role to a session that stays, then split`;
        }
    }
    return undefined;
}
/** The moved sub-leads' lists, kept to the moved sessions; the child's lead leads the rest of them itself. */
function childLeadsOf(parent, spec, moved) {
    const kept = Object.entries(parent.config.leads)
        .filter(([lead]) => moved.has(lead) && lead !== spec.lead)
        .map(([lead, ids]) => [lead, ids.filter((id) => moved.has(id))])
        .filter(([, ids]) => ids.length > 0);
    return Object.fromEntries(kept);
}
/**
 * The child's config as team create writes it, plus what keeps the moved sessions as they were: their names, launch
 * blocks and sub-leads, the parent's time zone, and the parent's holder of each role a child may leave to a team above.
 */
function childConfigOf(parent, spec) {
    const moved = new Set(spec.sessions);
    const roles = { lead: spec.lead };
    for (const role of ANCESTOR_ROLES) {
        const holder = parent.config.roles[role];
        if (holder !== undefined) {
            roles[role] = ADDRESS_PATTERN.test(holder) ? holder : `${parent.team}/${holder}`;
        }
    }
    const launch = recordField(parent.record, 'launch');
    const blocks = spec.sessions.flatMap((id) => {
        const block = launch === undefined ? undefined : recordField(launch, id);
        return block === undefined ? [] : [[id, block]];
    });
    const leads = childLeadsOf(parent, spec, moved);
    const record = {
        ...configRecordOf(spec),
        ...(parent.config.timeZone === undefined ? {} : { timeZone: parent.config.timeZone }),
        names: Object.fromEntries(spec.sessions.map((id) => [id, parent.roster.nameOf(id) ?? id])),
        roles,
        ...(Object.keys(leads).length === 0 ? {} : { leads }),
        ...(blocks.length === 0 ? {} : { launch: Object.fromEntries(blocks) }),
    };
    const [issue] = parseConfig(record).issues;
    return issue === undefined ? ok(record) : fail(`team ${spec.team}'s config would break its schema at ${issue.path}: ${issue.message}`);
}
function problemKey(problem) {
    return JSON.stringify(problem);
}
/**
 * Why the child cannot join the tree beside its trimmed parent: its id taken, or a tree rule the split would break
 * that the tree did not break before. No name clash is new: the moved sessions keep the names they had.
 */
function treeProblem(tree, parent, child) {
    if (tree.node(child.team) !== undefined) {
        return `team ${child.team} exists already; a split makes a new team`;
    }
    const before = tree.node(parent.team);
    if (before === undefined) {
        return `team ${parent.team} is not in the tree of teams read from the kit home`;
    }
    const moved = new Set(child.sessions);
    const trimmed = {
        ...before,
        sessions: before.sessions.filter((id) => !moved.has(id)),
        names: new Map([...before.names].filter(([id]) => !moved.has(id))),
    };
    const known = new Set(tree.problems().map(problemKey));
    const added = tree
        .with(trimmed)
        .with(child)
        .problems()
        .find((problem) => !known.has(problemKey(problem)));
    return added === undefined ? undefined : `team ${child.team} cannot join that tree: ${describeTreeProblem(added, KIT_NAME)}`;
}
function trimOf(parent, moved) {
    const { names, launch, leads } = parent.config;
    const keys = [...moved].flatMap((id) => [
        ...(Object.hasOwn(names, id) ? [`names.${id}`] : []),
        ...(Object.hasOwn(launch, id) ? [`launch.${id}`] : []),
        ...(Object.hasOwn(leads, id) ? [`leads.${id}`] : []),
    ]);
    const listed = Object.entries(leads).flatMap(([lead, ids]) => ids.map((id) => ({ lead, id })));
    return {
        keys,
        leftLeads: listed.filter(({ lead, id }) => !moved.has(lead) && moved.has(id)),
        unled: listed.filter(({ lead, id }) => moved.has(lead) && !moved.has(id)),
    };
}
/** The sessions a task names, by where it names them; its owner moves with it and is never rewritten. */
function namedSessions(task) {
    const named = [['source', task.source]];
    if (task.pin !== null) {
        named.push(['pin', task.pin]);
    }
    if (task.answer !== null) {
        named.push(['answer', task.answer.by]);
    }
    for (const wait of task.waits) {
        if (wait.kind === 'decision' || wait.kind === 'approval') {
            named.push([wait.kind, wait.who]);
        }
    }
    return named;
}
/**
 * The sessions tasks name across the new border, as `<team>/<id>`: a staying session in a moving task names the
 * parent, a moved one in a staying task the child. The owner marker and a name already `<team>/<id>` stay as written.
 */
function rewritesOf(tasks, moved, spec, parent) {
    const owner = parent.config.register.ownerSource;
    return [...tasks].flatMap((task) => {
        const moves = moved.has(task.owner);
        return namedSessions(task).flatMap(([field, from]) => {
            if (from === owner || ADDRESS_PATTERN.test(from) || moved.has(from) === moves) {
                return [];
            }
            return [{ task: task.id, field, from, to: `${moves ? parent.team : spec.team}/${from}` }];
        });
    });
}
/** The `after` and task-wait links between a moving task and a staying one of the working set. */
function linksOf(tasks, moving) {
    return [...tasks.values()].flatMap((task) => {
        const taskMoves = moving.has(task.id);
        const crossing = (on) => tasks.has(on) && moving.has(on) !== taskMoves;
        const after = task.after.filter(crossing).map((on) => ({ task: task.id, on, kind: 'after', taskMoves }));
        const waits = task.waits
            .flatMap((wait) => (wait.kind === 'task' && crossing(wait.id) ? [wait.id] : []))
            .map((on) => ({ task: task.id, on, kind: 'waits', taskMoves }));
        return [...after, ...waits];
    });
}
/**
 * Plans moving `spec.sessions` of the parent, `spec.lead` leading them, into the new child team `spec.team` under it,
 * with every task they own in the parent's working set (`tasks`). Refused: a session not on the parent, the parent's
 * lead or the holder of one of its roles among them, a child id another team has, and a child the tree's limits forbid.
 */
export function planTeamSplit(parent, spec, tree, tasks) {
    const problem = sessionProblem(parent, spec);
    if (problem !== undefined) {
        return fail(problem);
    }
    const config = childConfigOf(parent, spec);
    if (!config.ok) {
        return config;
    }
    const { config: parsed } = parseConfig(config.value);
    const placed = treeProblem(tree, parent, teamNodeOf(spec.team, parsed, new Roster(parsed, spec.team)));
    if (placed !== undefined) {
        return fail(placed);
    }
    const moved = new Set(spec.sessions);
    const moving = [...tasks.values()].filter((task) => moved.has(task.owner));
    return ok({
        spec,
        config: config.value,
        moving,
        staying: tasks.size - moving.length,
        links: linksOf(tasks, new Set(moving.map((task) => task.id))),
        rewrites: rewritesOf(tasks.values(), moved, spec, parent),
        trim: trimOf(parent, moved),
    });
}
