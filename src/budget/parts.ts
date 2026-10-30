import { DEFAULT_SESSION_SHARE } from '../config/defaults.ts';
import type { KitConfig, SessionBudget } from '../config/types.ts';
import { activeGroupLift, activeLift, type Lift } from './lift.ts';
import { workWeightOf, type WorkByPriority } from './work.ts';

/** How the team's daily budget is split among its sessions; every part moves with the budget it splits. */
export interface BudgetSplit {
  /** The team's id: its node when the account's daily budget is split among the teams on it. */
  readonly team: string;
  /** The team's sessions, the whole roster. */
  readonly ids: readonly string[];
  readonly sessions: Readonly<Record<string, SessionBudget>>;
  /** The sub-leads over the sessions they list (T781): the split tree follows this lead tree (`teamTreeOf`). */
  readonly leads: KitConfig['leads'];
  /** Each session's queued work by priority (`workWeights`); a session not in it counts 1. */
  readonly work: ReadonlyMap<string, WorkByPriority>;
  /** The session lifts in force, as each lifted session's part of its parent's budget in percent (`budgetSplitOf`). */
  readonly lifted: ReadonlyMap<string, number>;
  /** The group lifts in force, as each lifted sub-lead's group's part of its parent's budget in percent. */
  readonly liftedGroups: ReadonlyMap<string, number>;
}

/** The team that asks (`split`) and the other teams on its Claude account (`accountTeamsOf`), which share the account's week. */
export interface TeamsOnAccount {
  readonly split: BudgetSplit;
  readonly others: readonly BudgetSplit[];
}

/** A session in the split tree. */
export interface SplitLeaf {
  readonly id: string;
  /** Its lift in force, as its part of its parent's budget in percent; undefined when not lifted. */
  readonly liftedPct: number | undefined;
  /** Its `share` times its queued work, at least 1 so a session with none still gets a part. */
  readonly weight: number;
}

/** A node that splits its part among its nodes (a team, a sub-lead's group); its weight is theirs summed. */
export interface SplitGroup {
  readonly id: string;
  readonly liftedPct: number | undefined;
  readonly nodes: readonly SplitNode[];
}

export type SplitNode = SplitLeaf | SplitGroup;

function weightOf(node: SplitNode): number {
  return 'nodes' in node ? node.nodes.reduce((sum, each) => sum + weightOf(each), 0) : node.weight;
}

/**
 * A node's part of its parent's budget (`parentPct`, in percent of the week): a lifted node's is its lift's part of
 * it; what the lifts among `siblings` (the node among them) leave is split among the unlifted ones by weight.
 */
function partAmong(parentPct: number, node: SplitNode, siblings: readonly SplitNode[]): number {
  if (node.liftedPct !== undefined) {
    return (parentPct * node.liftedPct) / 100;
  }
  let liftedPct = 0;
  let weights = 0;
  for (const each of siblings) {
    if (each.liftedPct === undefined) {
      weights += weightOf(each);
    } else {
      liftedPct += each.liftedPct;
    }
  }
  const rest = (parentPct * Math.max(0, 100 - liftedPct)) / 100;
  return weights > 0 ? (rest * weightOf(node)) / weights : 0;
}

/**
 * The part of a budget (`budgetPct`, in percent of the week) that the node at `path` gets, `path` being its ids from
 * the top `nodes` down, split level by level (`partAmong`). Recomputed with the budget, so no node waits while the
 * week has room and the parts never add up to more than the budget. Undefined when no node is at `path`.
 */
export function partOf(budgetPct: number, nodes: readonly SplitNode[], path: readonly string[]): number | undefined {
  let pct = budgetPct;
  let level = nodes;
  let node: SplitNode | undefined;
  for (const id of path) {
    node = level.find((each) => each.id === id);
    if (node === undefined) {
      return undefined;
    }
    pct = partAmong(pct, node, level);
    level = 'nodes' in node ? node.nodes : [];
  }
  return node === undefined ? undefined : pct;
}

/** The nodes `path` leads to from the top `nodes` down: those of the group at its end, the top's for an empty path. */
function nodesAt(nodes: readonly SplitNode[], path: readonly string[]): readonly SplitNode[] {
  let level = nodes;
  for (const id of path) {
    const node = level.find((each) => each.id === id);
    level = node !== undefined && 'nodes' in node ? node.nodes : [];
  }
  return level;
}

/** A session as a split-tree leaf, weighed by its `share` and queued work, with its session lift in force. */
function leafOf(split: BudgetSplit, id: string): SplitLeaf {
  return { id, liftedPct: split.lifted.get(id), weight: (split.sessions[id]?.share ?? DEFAULT_SESSION_SHARE) * Math.max(1, workWeightOf(split.work.get(id))) };
}

/** The team's split tree, and where each session and each sub-lead's group sits in it: its ids from the top down. */
export interface TeamTree {
  readonly nodes: readonly SplitNode[];
  /** Each session's path; a sub-lead's ends at its own leaf, inside its group. */
  readonly sessionPaths: ReadonlyMap<string, readonly string[]>;
  /** Each sub-lead's group's path. */
  readonly groupPaths: ReadonlyMap<string, readonly string[]>;
}

/**
 * The team as a split tree that follows its lead tree (`leads`): the lead and the sessions no sub-lead lists at the
 * top, in roster order, and each sub-lead a group of its own leaf and the sessions it lists, at any depth. A group
 * weighs what its sessions weigh together, so while no group is lifted each session gets the part a flat split of the
 * team gives it. A sub-lead off the roster leads no group here. A session in a loop of listings (the parser refuses
 * them) hangs under no group the top reaches, so it has no path and no budget.
 */
export function teamTreeOf(split: BudgetSplit): TeamTree {
  const subLeads = new Set(Object.keys(split.leads).filter((id) => split.ids.includes(id)));
  const listedBy = new Map(
    Object.entries(split.leads)
      .filter(([subLead]) => subLeads.has(subLead))
      .flatMap(([subLead, members]) => members.map((member) => [member, subLead] as const)),
  );
  const sessionPaths = new Map<string, readonly string[]>();
  const groupPaths = new Map<string, readonly string[]>();
  const nodesUnder = (leader: string | undefined, above: readonly string[]): SplitNode[] =>
    split.ids
      .filter((id) => listedBy.get(id) === leader)
      .map((id): SplitNode => {
        const path = [...above, id];
        if (!subLeads.has(id)) {
          sessionPaths.set(id, path);
          return leafOf(split, id);
        }
        groupPaths.set(id, path);
        sessionPaths.set(id, [...path, id]);
        return { id, liftedPct: split.liftedGroups.get(id), nodes: [leafOf(split, id), ...nodesUnder(id, path)] };
      });
  return { nodes: nodesUnder(undefined, []), sessionPaths, groupPaths };
}

/** The team as a split-tree node: its tree's top nodes (`teamTreeOf`) under its id, its weight theirs summed. */
function teamGroupOf(split: BudgetSplit, tree: TeamTree = teamTreeOf(split)): SplitGroup {
  return { id: split.team, liftedPct: undefined, nodes: tree.nodes };
}

/**
 * The team's part of an amount the account shares (`pct`, in percent of the week: its day, its spare), split among the
 * teams on the account (the team's `split` and the `others`, `accountTeamsOf`) by their sessions' summed weights: all
 * of it while no other team is on the account.
 */
export function teamShareOf(pct: number, split: BudgetSplit, others: readonly BudgetSplit[]): number {
  if (others.length === 0) {
    return pct;
  }
  const team = teamGroupOf(split);
  return partAmong(pct, team, [team, ...others.map((each) => teamGroupOf(each))]);
}

/** The team's part (`teamShareOf`) of the account's daily budget (`allowancePct`); undefined while the account's is unknown. */
export function teamPartOf(allowancePct: number | undefined, split: BudgetSplit, others: readonly BudgetSplit[] = []): number | undefined {
  return allowancePct === undefined ? undefined : teamShareOf(allowancePct, split, others);
}

/**
 * The session's daily budget now, in percent of the week: its part (`partOf`) of its team's part (`teamPartOf`) of
 * the account's (`allowancePct`), down its team's tree (`teamTreeOf`); a lift is its part of its parent's, the team's
 * or its sub-lead's group's. Undefined while the account's is unknown, or for a session the tree does not hold.
 */
export function dailyBudgetOf(allowancePct: number | undefined, session: string, split: BudgetSplit, others: readonly BudgetSplit[] = []): number | undefined {
  if (allowancePct === undefined) {
    return undefined;
  }
  const tree = teamTreeOf(split);
  const path = tree.sessionPaths.get(session);
  return path === undefined ? undefined : budgetAt(allowancePct, path, split, tree, others);
}

/**
 * The part of the account's daily budget (`allowancePct`) that the node at `path` in the team's tree (`tree`) gets:
 * of the team's part (`teamPartOf`) beside the `others`, of the whole day while no other team is on the account.
 */
function budgetAt(allowancePct: number, path: readonly string[], split: BudgetSplit, tree: TeamTree, others: readonly BudgetSplit[]): number | undefined {
  // With no other team the path skips the team level: an exact split of the day, not one an ulp off it.
  return others.length === 0
    ? partOf(allowancePct, tree.nodes, path)
    : partOf(allowancePct, [teamGroupOf(split, tree), ...others.map((each) => teamGroupOf(each))], [split.team, ...path]);
}

/** A sub-lead's group's part of the day (`groupPartsOf`). */
export interface GroupPart {
  /** The sub-lead's id. */
  readonly id: string;
  /** The group's sessions at any depth, the sub-lead's own included, in tree order. */
  readonly sessions: readonly string[];
  /** The group's daily budget now, in percent of the week; undefined while the account's is unknown. */
  readonly budgetPct: number | undefined;
  /** Its group lift in force, as its part of its parent's budget in percent; undefined when not lifted. */
  readonly liftedPct: number | undefined;
}

/**
 * Each sub-lead's group's part (`GroupPart`) of the account's daily budget (`allowancePct`), down its team's tree
 * (`teamTreeOf`) as `dailyBudgetOf` splits it: the budget its sessions' parts are split from. In tree order, each
 * group before the groups under it; none while no sub-lead on the roster leads.
 */
export function groupPartsOf(allowancePct: number | undefined, split: BudgetSplit, others: readonly BudgetSplit[] = []): GroupPart[] {
  const tree = teamTreeOf(split);
  return [...tree.groupPaths].map(([id, path]) => ({
    id,
    sessions: [...tree.sessionPaths].filter(([, sessionPath]) => sessionPath.includes(id)).map(([session]) => session),
    budgetPct: allowancePct === undefined ? undefined : budgetAt(allowancePct, path, split, tree, others),
    liftedPct: split.liftedGroups.get(id),
  }));
}

/** Where a lift takes its part from: its parent node in the team's tree. */
export interface LiftPlace {
  /** The sub-lead whose group's budget the lift is a part of; undefined for the team's. */
  readonly parent: string | undefined;
  /** The other lifts in force under that parent, summed, in percent of its budget. */
  readonly liftedPct: number;
}

/**
 * The place (`LiftPlace`) of a lift of session `id`, or with `group` of sub-lead `id`'s group: a sub-lead's own leaf
 * is inside its group, so its session lift is a part of its group's budget. The lift `id` already has is not counted:
 * a new one replaces it. Undefined for a session or group the tree does not hold.
 */
export function liftPlaceOf(split: BudgetSplit, id: string, group: boolean): LiftPlace | undefined {
  const tree = teamTreeOf(split);
  const path = (group ? tree.groupPaths : tree.sessionPaths).get(id);
  if (path === undefined) {
    return undefined;
  }
  const liftedPct = nodesAt(tree.nodes, path.slice(0, -1)).reduce((sum, each) => (each.id === id ? sum : sum + (each.liftedPct ?? 0)), 0);
  return { parent: path.at(-2), liftedPct };
}

/** What `budgetSplitOf` splits by: the team's roster, shares, lead tree and queued work, and its lift log. */
export interface SplitSource extends Omit<BudgetSplit, 'lifted' | 'liftedGroups'> {
  readonly lifts: readonly Lift[];
  /** The lifts in force at `now` with the week's use at `usedPct` (`activeLift`) count. */
  readonly now: number;
  readonly usedPct: number | undefined;
}

/** The team's split, with the session and group lifts in force (`activeLift`, `activeGroupLift`) as their parts. */
export function budgetSplitOf(source: SplitSource): BudgetSplit {
  const { lifts, now, usedPct, ...split } = source;
  const subLeads = Object.keys(split.leads).filter((id) => split.ids.includes(id));
  return {
    ...split,
    lifted: partsInForce(split.ids, (id) => activeLift(lifts, id, now, usedPct)),
    liftedGroups: partsInForce(subLeads, (id) => activeGroupLift(lifts, id, now, usedPct)),
  };
}

function partsInForce(ids: readonly string[], liftOf: (id: string) => Lift | undefined): ReadonlyMap<string, number> {
  const parts = new Map<string, number>();
  for (const id of ids) {
    const lift = liftOf(id);
    if (lift !== undefined) {
      parts.set(id, lift.partPct);
    }
  }
  return parts;
}

/** An id no roster holds (a session id starts with a lowercase letter), for the session `addedSessionPct` adds. */
const ADDED_SESSION = '+added';

/**
 * The part of the account's daily budget (`allowancePct`, in percent of the week) one more session of the team would
 * get: added at the top of its tree at the default share with no queued work, it takes its part out of the other
 * sessions' on the account (`others` being its other teams), as a new hire does.
 */
export function addedSessionPct(allowancePct: number, split: BudgetSplit, others: readonly BudgetSplit[] = []): number {
  return dailyBudgetOf(allowancePct, ADDED_SESSION, { ...split, ids: [...split.ids, ADDED_SESSION] }, others) ?? 0;
}
