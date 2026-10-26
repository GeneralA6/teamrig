import { parseConfig } from '../config/parse.ts';
import { ANCESTOR_ROLES, Roster } from '../config/roster.ts';
import { describeTreeProblem, teamNodeOf, type TeamNode, type TeamTree, type TreeProblem } from '../config/tree.ts';
import type { KitConfig } from '../config/types.ts';
import { ADDRESS_PATTERN } from '../core/address.ts';
import { isStringArray, recordField, type JsonRecord } from '../core/guards.ts';
import { KIT_NAME } from '../core/home.ts';
import type { Task } from '../register/fold.ts';
import type { PersonWaitKind } from '../register/waits.ts';
import { configRecordOf, type Checked, type TeamSpec } from './team-create.ts';

/**
 * `teamrig team split`: moves sessions of a team, with the tasks they own, into a new child team under it (T1144).
 * This module plans the split from what the command read; it reads and writes nothing itself. The child keeps each
 * moved session's name and launch block, so no tab title or message address changes, and the roles it lacks name
 * the parent's holders as `<parent>/<id>` (T1143). A task that names a session across the new border names it as
 * `<team>/<id>` from then on, so a done line still reaches who asked.
 */

/** The team a split takes sessions from, as read before it. */
export interface SplitParent {
  readonly team: string;
  readonly config: KitConfig;
  /** The config file's own JSON: the child copies the moved sessions' launch blocks as written. */
  readonly record: JsonRecord;
  readonly roster: Roster;
}

/** Where a task names a session: who asked for it, who pinned it, who answered its approval, or a wait on a person. */
export type SplitField = 'source' | 'pin' | 'answer' | PersonWaitKind;

/** A session a task names, rewritten so it still names the same session from the other team. */
export interface SplitRewrite {
  readonly task: string;
  readonly field: SplitField;
  readonly from: string;
  readonly to: string;
  /** True when the task moves, so its lines name `to` in the child's register; false: an update in the parent does. */
  readonly moves: boolean;
}

/**
 * How a task on one side of the new border names a session from then on: as written when the session is on the same
 * side, is the owner's marker or is named as `<team>/<id>` already; else as `<team>/<id>` of the team it is on.
 */
export class SplitBorder {
  private readonly parent: string;
  private readonly child: string;
  private readonly moved: ReadonlySet<string>;
  private readonly ownerSource: string;

  constructor(parent: string, child: string, moved: Iterable<string>, ownerSource: string) {
    this.parent = parent;
    this.child = child;
    this.moved = new Set(moved);
    this.ownerSource = ownerSource;
  }

  /** Whether a task its owner `owner` holds moves with the split. */
  moves(owner: string): boolean {
    return this.moved.has(owner);
  }

  /** `name` as a task on the moving side (`moves`) or the staying side names it from then on; undefined when as written. */
  crossing(moves: boolean, name: string): string | undefined {
    if (name === this.ownerSource || ADDRESS_PATTERN.test(name) || this.moved.has(name) === moves) {
      return undefined;
    }
    return `${moves ? this.parent : this.child}/${name}`;
  }
}

/** What a split does to the tasks of the parent's working set. */
export interface SplitTasks {
  /** The tasks that move, in register order; the archive stays with the parent. */
  readonly moving: readonly Task[];
  readonly staying: number;
  readonly links: readonly SplitLink[];
  /** The sessions tasks name across the new border, which the split writes as `<team>/<id>`. */
  readonly rewrites: readonly SplitRewrite[];
  /**
   * Waits of staying tasks on a moved session's decision or approval: no session of the parent could give it, so the
   * split refuses until each is asked of a session that stays.
   */
  readonly blockers: readonly SplitRewrite[];
}

/** A link between a task that moves and one that stays: `task` runs after `on`, or waits on it. */
export interface SplitLink {
  readonly task: string;
  readonly on: string;
  readonly kind: 'after' | 'waits';
  /** True when `task` moves and `on` stays; false the other way round. */
  readonly taskMoves: boolean;
}

/** A session on a `leads` list, by the sub-lead whose list it is. */
export interface LedSession {
  readonly lead: string;
  readonly id: string;
}

/** What the parent's config loses besides the moved sessions. */
export interface ParentTrim {
  /** Keys removed whole: `names.<id>`, `launch.<id>` and `leads.<id>` of the moved sessions. */
  readonly keys: readonly string[];
  /** Moved sessions taken off a staying sub-lead's list. */
  readonly leftLeads: readonly LedSession[];
  /** Staying sessions a moved sub-lead led: the parent's lead leads them from then on. */
  readonly unled: readonly LedSession[];
}

export interface SplitPlan extends SplitTasks {
  /** The child team: its id, its lead, its sessions with the lead first, and the parent as its parent. */
  readonly spec: TeamSpec;
  /** The child's config, as the split writes it. */
  readonly config: JsonRecord;
  readonly border: SplitBorder;
  readonly trim: ParentTrim;
}

function ok<T>(value: T): Checked<T> {
  return { ok: true, value };
}

function fail<T>(problem: string): Checked<T> {
  return { ok: false, problem };
}

/** Why the sessions cannot move: one not on the parent, the parent's lead, or the holder of a parent role. */
function sessionProblem(parent: SplitParent, spec: TeamSpec): string | undefined {
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
function childLeadsOf(parent: SplitParent, spec: TeamSpec, moved: ReadonlySet<string>): Record<string, string[]> {
  const kept = Object.entries(parent.config.leads)
    .filter(([lead]) => moved.has(lead) && lead !== spec.lead)
    .map(([lead, ids]): [string, string[]] => [lead, ids.filter((id) => moved.has(id))])
    .filter(([, ids]) => ids.length > 0);
  return Object.fromEntries(kept);
}

/**
 * The child's config as team create writes it, plus what keeps the moved sessions as they were: their names, launch
 * blocks and sub-leads, the parent's time zone, and the parent's holder of each role a child may leave to a team above.
 */
function childConfigOf(parent: SplitParent, spec: TeamSpec): Checked<JsonRecord> {
  const moved = new Set(spec.sessions);
  const roles: Record<string, string> = { lead: spec.lead };
  for (const role of ANCESTOR_ROLES) {
    const holder = parent.config.roles[role];
    if (holder !== undefined) {
      roles[role] = ADDRESS_PATTERN.test(holder) ? holder : `${parent.team}/${holder}`;
    }
  }
  const launch = recordField(parent.record, 'launch');
  const blocks = spec.sessions.flatMap((id): [string, JsonRecord][] => {
    const block = launch === undefined ? undefined : recordField(launch, id);
    return block === undefined ? [] : [[id, block]];
  });
  const leads = childLeadsOf(parent, spec, moved);
  const record: JsonRecord = {
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

function problemKey(problem: TreeProblem): string {
  return JSON.stringify(problem);
}

/**
 * Why the child cannot join the tree beside its trimmed parent: its id taken, or a tree rule the split would break
 * that the tree did not break before. No name clash is new: the moved sessions keep the names they had.
 */
function treeProblem(tree: TeamTree, parent: SplitParent, child: TeamNode): string | undefined {
  if (tree.node(child.team) !== undefined) {
    return `team ${child.team} exists already; a split makes a new team`;
  }
  const before = tree.node(parent.team);
  if (before === undefined) {
    return `team ${parent.team} is not in the tree of teams read from the kit home`;
  }
  const moved = new Set(child.sessions);
  const trimmed: TeamNode = {
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

function trimOf(parent: SplitParent, moved: ReadonlySet<string>): ParentTrim {
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
function namedSessions(task: Task): [SplitField, string][] {
  const named: [SplitField, string][] = [['source', task.source]];
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

/** The sessions tasks name across the new border (SplitBorder): a staying session in a moving task, a moved one in a staying task. */
function crossingsOf(tasks: Iterable<Task>, border: SplitBorder): SplitRewrite[] {
  return [...tasks].flatMap((task) => {
    const moves = border.moves(task.owner);
    return namedSessions(task).flatMap(([field, from]): SplitRewrite[] => {
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
export function splitTasksOf(tasks: ReadonlyMap<string, Task>, border: SplitBorder): SplitTasks {
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
function linksOf(tasks: ReadonlyMap<string, Task>, moving: ReadonlySet<string>): SplitLink[] {
  return [...tasks.values()].flatMap((task) => {
    const taskMoves = moving.has(task.id);
    const crossing = (on: string): boolean => tasks.has(on) && moving.has(on) !== taskMoves;
    const after = task.after.filter(crossing).map((on): SplitLink => ({ task: task.id, on, kind: 'after', taskMoves }));
    const waits = task.waits
      .flatMap((wait) => (wait.kind === 'task' && crossing(wait.id) ? [wait.id] : []))
      .map((on): SplitLink => ({ task: task.id, on, kind: 'waits', taskMoves }));
    return [...after, ...waits];
  });
}

/**
 * Plans moving `spec.sessions` of the parent, `spec.lead` leading them, into the new child team `spec.team` under it,
 * with every task they own in the parent's working set (`tasks`). Refused: a session not on the parent, the parent's
 * lead or the holder of one of its roles among them, a child id another team has, and a child the tree's limits forbid.
 */
export function planTeamSplit(parent: SplitParent, spec: TeamSpec, tree: TeamTree, tasks: ReadonlyMap<string, Task>): Checked<SplitPlan> {
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
  return ok({ spec, config: config.value, border, ...splitTasksOf(tasks, border), trim: trimOf(parent, new Set(spec.sessions)) });
}

/** The map at `key` without the keys of moved sessions; nothing when the parent has no such map. */
function withoutMoved(record: JsonRecord, key: string, moved: ReadonlySet<string>): JsonRecord {
  const map = recordField(record, key);
  return map === undefined ? {} : { [key]: Object.fromEntries(Object.entries(map).filter(([id]) => !moved.has(id))) };
}

/** The sub-leads' lists without a moved sub-lead's, and each staying one's without the moved sessions, an emptied one dropped. */
function trimmedLeads(record: JsonRecord, moved: ReadonlySet<string>): JsonRecord {
  const leads = recordField(record, 'leads');
  if (leads === undefined) {
    return {};
  }
  const kept = Object.entries(leads).flatMap(([lead, ids]): [string, unknown][] => {
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
 * blocks and sub-leads' lists (ParentTrim says which), every other key as it was.
 */
export function trimmedParentOf(record: JsonRecord, moved: ReadonlySet<string>): JsonRecord {
  const sessions = record['sessions'];
  return {
    ...record,
    ...(isStringArray(sessions) ? { sessions: sessions.filter((id) => !moved.has(id)) } : {}),
    ...withoutMoved(record, 'names', moved),
    ...withoutMoved(record, 'launch', moved),
    ...trimmedLeads(record, moved),
  };
}
