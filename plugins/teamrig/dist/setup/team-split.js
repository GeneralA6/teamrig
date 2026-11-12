import { parseConfig } from "../config/parse.js";
import { ANCESTOR_ROLES, Roster } from "../config/roster.js";
import { describeTreeProblem, teamNodeOf } from "../config/tree.js";
import { ACCOUNT_BUDGET_KEYS } from "../config/types.js";
import { deliveryDirOf, teamPlace } from "../delivery/places.js";
import { ADDRESS_PATTERN } from "../core/address.js";
import { isRecord, isStringArray, recordField } from "../core/guards.js";
import { KIT_NAME } from "../core/home.js";
import { configRecordOf } from "./team-create.js";
/**
 * The blocks the child takes changed: one delivery flow per host, so its folder, host lock and main checkouts stay the
 * parent's and two queued steps never overlap; the budget and the idle pass hold only the moved sessions' entries, and the
 * budget none of the keys of the account's week, which the child reads from the parent.
 */
const REWORKED = { delivery: sharedDeliveryOf, budget: movedBudgetOf, open: movedOpenOf };
/**
 * How the child takes every other key of the parent's config, so a key added to the config cannot be left out without
 * a choice here: `github` is the parent's alone, as each repository's issues go to one team, and `paths` are a team's
 * own folders; every setting is copied, so the child runs as its parent did.
 */
const CHILD_TAKES = {
    configVersion: 'split',
    team: 'split',
    sessions: 'split',
    names: 'split',
    roles: 'split',
    leads: 'split',
    launch: 'split',
    github: 'own',
    paths: 'own',
    timeZone: 'copy',
    ownerGates: 'copy',
    ruleConflicts: 'copy',
    messages: 'copy',
    register: 'copy',
    skills: 'copy',
    contextFiles: 'copy',
    lock: 'copy',
    exec: 'copy',
    pushGuard: 'copy',
    packageGuard: 'copy',
    commitGuard: 'copy',
    prompts: 'copy',
    secretGuard: 'copy',
    commits: 'copy',
    leadBoundary: 'copy',
    loops: 'copy',
    wake: 'copy',
    tests: 'copy',
    alerts: 'copy',
    decisions: 'copy',
    tabStatus: 'copy',
    pickerGuard: 'copy',
    meeting: 'copy',
    turnLog: 'copy',
    readonlyShell: 'copy',
    permissions: 'copy',
    refresh: 'copy',
    hiring: 'copy',
    burst: 'copy',
    statusLine: 'copy',
    focus: 'copy',
};
const TAKES = new Map(Object.entries(CHILD_TAKES));
/**
 * How a task on one side of the new border names a session from then on: as written when the session is on the same
 * side, is the owner's marker or is named as `<team>/<id>` already; else as `<team>/<id>` of the team it is on.
 */
export class SplitBorder {
    parent;
    child;
    moved;
    ownerSource;
    constructor(parent, child, moved, ownerSource) {
        this.parent = parent;
        this.child = child;
        this.moved = new Set(moved);
        this.ownerSource = ownerSource;
    }
    /** Whether a task its owner `owner` holds moves with the split. */
    moves(owner) {
        return this.moved.has(owner);
    }
    /** `name` as a task on the moving side (`moves`) or the staying side names it from then on; undefined when as written. */
    crossing(moves, name) {
        if (name === this.ownerSource || ADDRESS_PATTERN.test(name) || this.moved.has(name) === moves) {
            return undefined;
        }
        return `${moves ? this.parent : this.child}/${name}`;
    }
}
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
/** The path at `key` made absolute to the parent's folder; the record as it is when it holds none there. */
function placedAt(record, key, parent) {
    const path = record[key];
    return typeof path === 'string' ? { ...record, [key]: teamPlace(parent.paths, path) } : record;
}
/**
 * The parent's delivery config, written even when the parent leaves it to its defaults: the child keeps its ledger,
 * deploy freezes and pending merges in the parent's folder, and a relative host lock or main checkout is made
 * absolute to it.
 */
function sharedDeliveryOf(block, { parent }) {
    const raw = block ?? {};
    const queue = recordField(raw, 'queue');
    const repos = recordField(raw, 'repos');
    return {
        ...raw,
        dir: deliveryDirOf(parent.config.delivery, parent.paths),
        ...(queue === undefined ? {} : { queue: placedAt(queue, 'lockPath', parent) }),
        ...(repos === undefined
            ? {}
            : { repos: Object.fromEntries(Object.entries(repos).map(([name, repo]) => [name, isRecord(repo) ? placedAt(repo, 'mainCheckout', parent) : repo])) }),
    };
}
/** The budget keys of the account's week, which a child reads from its parent (`AccountBudget`) and so never copies. */
const ACCOUNT_KEYS = new Set(ACCOUNT_BUDGET_KEYS);
/**
 * The parent's budget with the moved sessions' shares only, its status line folder made absolute to the parent's, and
 * without the keys of the account's week (ACCOUNT_KEYS): a copy of those would drift from the parent's. Nothing when
 * no other key is left.
 */
function movedBudgetOf(block, { parent, moved }) {
    if (block === undefined) {
        return undefined;
    }
    const taken = { ...placedAt(block, 'statusSnapshotDir', parent), ...keptIn(block, 'sessions', (id) => moved.has(id)) };
    const own = Object.entries(taken).filter(([key]) => !ACCOUNT_KEYS.has(key));
    return own.length === 0 ? undefined : Object.fromEntries(own);
}
/** The parent's `open` block with its idle pass keeping open only moved sessions. */
function movedOpenOf(block, { moved }) {
    return block === undefined ? undefined : idleKeptBy(block, (id) => moved.has(id));
}
/** The parent's blocks as the child takes them: a copy as the parent holds them (CHILD_TAKES), or reworked (REWORKED). */
function takenBlocks(scope) {
    const { current } = scope.parent;
    const copied = Object.entries(current).filter(([key]) => TAKES.get(key) === 'copy');
    const reworks = Object.entries(REWORKED);
    const reworked = reworks.flatMap(([key, rework]) => {
        const block = rework(recordField(current, key), scope);
        return block === undefined ? [] : [[key, block]];
    });
    return Object.fromEntries([...copied, ...reworked]);
}
/** The keys the parent's config sets that the child starts without: those CHILD_TAKES leaves the parent, and unknown ones. */
function leftOutOf(parent) {
    return Object.keys(parent.current).filter((key) => {
        const take = TAKES.get(key);
        return take === 'own' || (take === undefined && !Object.hasOwn(REWORKED, key));
    });
}
/**
 * The child's config as team create writes it, plus every block of the parent's (takenBlocks), so the child runs as its
 * parent did, and what keeps the moved sessions as they were: their names, launch blocks and sub-leads, and the parent's
 * holder of each role a child may leave to a team above.
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
    const launch = recordField(parent.current, 'launch');
    const blocks = spec.sessions.flatMap((id) => {
        const block = launch === undefined ? undefined : recordField(launch, id);
        return block === undefined ? [] : [[id, block]];
    });
    const leads = childLeadsOf(parent, spec, moved);
    const record = {
        ...configRecordOf(spec),
        ...takenBlocks({ parent, moved }),
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
    const { names, launch, leads, budget, open } = parent.config;
    const keys = [...moved].flatMap((id) => [
        ...(Object.hasOwn(names, id) ? [`names.${id}`] : []),
        ...(Object.hasOwn(launch, id) ? [`launch.${id}`] : []),
        ...(Object.hasOwn(leads, id) ? [`leads.${id}`] : []),
        ...(Object.hasOwn(budget.sessions, id) ? [`budget.sessions.${id}`] : []),
        ...(open.idle.keepOpen.includes(id) ? [`open.idle.keepOpen[${id}]`] : []),
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
    if (task.decided !== null) {
        named.push(['decided', task.decided.by]);
    }
    for (const wait of task.waits) {
        if (wait.kind === 'decision' || wait.kind === 'approval') {
            named.push([wait.kind, wait.who]);
        }
    }
    return named;
}
/** The sessions tasks name across the new border (SplitBorder): a staying session in a moving task, a moved one in a staying task. */
function crossingsOf(tasks, border) {
    return [...tasks].flatMap((task) => {
        const moves = border.moves(task.owner);
        return namedSessions(task).flatMap(([field, from]) => {
            const to = border.crossing(moves, from);
            return to === undefined ? [] : [{ task: task.id, field, from, to, moves }];
        });
    });
}
/**
 * What the split does to the tasks of the parent's working set: those the moved sessions own move, the links between
 * them and the rest cross the border, and so do the sessions they name. A moving task's lines are rewritten whole; a
 * staying one gets an update for who asked and who pinned it, a wait on a moved session's decision or approval blocks
 * the split, and an approval a moved session gave stays as written, as no update can give it again.
 */
export function splitTasksOf(tasks, border) {
    const moving = [...tasks.values()].filter((task) => border.moves(task.owner));
    const crossings = crossingsOf(tasks.values(), border);
    return {
        moving,
        staying: tasks.size - moving.length,
        links: linksOf(tasks, new Set(moving.map((task) => task.id))),
        rewrites: crossings.filter((rewrite) => rewrite.moves || rewrite.field === 'source' || rewrite.field === 'pin'),
        blockers: crossings.filter((rewrite) => !rewrite.moves && (rewrite.field === 'decision' || rewrite.field === 'approval')),
    };
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
    const border = new SplitBorder(parent.team, spec.team, spec.sessions, parent.config.register.ownerSource);
    return ok({ spec, config: config.value, leftOut: leftOutOf(parent), border, ...splitTasksOf(tasks, border), trim: trimOf(parent, new Set(spec.sessions)) });
}
/** The map at `key` with only the sessions `keep` keeps; nothing when the record has no such map. */
function keptIn(record, key, keep) {
    const map = recordField(record, key);
    return map === undefined ? {} : { [key]: Object.fromEntries(Object.entries(map).filter(([id]) => keep(id))) };
}
/** The block at `key` as `change` makes it; nothing when the record has no such block. */
function changedBlock(record, key, change) {
    const block = recordField(record, key);
    return block === undefined ? {} : { [key]: change(block) };
}
/** An `open` block whose idle pass keeps open only the sessions `keep` keeps; a damaged list is left for the config check. */
function idleKeptBy(open, keep) {
    return {
        ...open,
        ...changedBlock(open, 'idle', (idle) => {
            const keepOpen = idle['keepOpen'];
            return isStringArray(keepOpen) ? { ...idle, keepOpen: keepOpen.filter(keep) } : idle;
        }),
    };
}
/** The sub-leads' lists without a moved sub-lead's, and each staying one's without the moved sessions, an emptied one dropped. */
function trimmedLeads(record, moved) {
    const leads = recordField(record, 'leads');
    if (leads === undefined) {
        return {};
    }
    const kept = Object.entries(leads).flatMap(([lead, ids]) => {
        if (moved.has(lead)) {
            return [];
        }
        const left = isStringArray(ids) ? ids.filter((id) => !moved.has(id)) : ids;
        return isStringArray(left) && left.length === 0 ? [] : [[lead, left]];
    });
    return { leads: Object.fromEntries(kept) };
}
/**
 * The parent's config after the split, as its file holds it: the moved sessions gone from its sessions, names, launch
 * blocks, sub-leads' lists, budget shares and idle keep-open list (ParentTrim says which), every other key as it was.
 */
export function trimmedParentOf(record, moved) {
    const sessions = record['sessions'];
    const stays = (id) => !moved.has(id);
    return {
        ...record,
        ...(isStringArray(sessions) ? { sessions: sessions.filter(stays) } : {}),
        ...keptIn(record, 'names', stays),
        ...keptIn(record, 'launch', stays),
        ...trimmedLeads(record, moved),
        ...changedBlock(record, 'budget', (budget) => ({ ...budget, ...keptIn(budget, 'sessions', stays) })),
        ...changedBlock(record, 'open', (open) => idleKeptBy(open, stays)),
    };
}
