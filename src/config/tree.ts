import type { SessionAddress } from '../core/address.ts';
import { TREE_LIMITS } from './limits.ts';
import type { Roster } from './roster.ts';
import type { KitConfig } from './types.ts';

/**
 * A tree of teams: each team config names its parent (`team.parent`), and the tree is read from
 * those links across every team folder of the kit home, so there is no registry file to drift. A
 * team with no parent is the root of its own tree. The tree only reads; each team keeps writing
 * only its own files.
 */

/** One team as the tree sees it: its folder name, its parent link, its lead and its sessions' names. */
export interface TeamNode {
  /** The team's id: its folder name under `<kit home>/teams/`. */
  readonly team: string;
  /** The id the config's `team.id` states, when it states one; it must equal the folder name. */
  readonly statedId: string | undefined;
  readonly parent: string | undefined;
  /** The lead's session id. */
  readonly lead: string;
  /** Every session id, the lead included. */
  readonly sessions: readonly string[];
  /** Each session's current name, by id: the Claude Code session name it runs under. */
  readonly names: ReadonlyMap<string, string>;
}

/** The node of a team, from its folder name, its config and its roster with the renames applied. */
export function teamNodeOf(team: string, config: Pick<KitConfig, 'team' | 'roles' | 'sessions'>, roster: Roster): TeamNode {
  return {
    team,
    statedId: config.team?.id,
    parent: config.team?.parent,
    lead: config.roles.lead,
    sessions: config.sessions,
    names: new Map(config.sessions.map((id) => [id, roster.nameOf(id) ?? id])),
  };
}

/**
 * - `tree-id`: a config whose `team.id` is not its folder name;
 * - `tree-parent`: a parent with no team config;
 * - `tree-loop`: teams whose parent links go round in a loop, so none reaches a root;
 * - `tree-depth`: a team below the deepest level a tree allows;
 * - `tree-children`: a team with more child teams than a team may have.
 */
export type TreeProblem =
  | { readonly kind: 'tree-id'; readonly team: string; readonly stated: string }
  | { readonly kind: 'tree-parent'; readonly team: string; readonly parent: string }
  | { readonly kind: 'tree-loop'; readonly teams: readonly string[] }
  | { readonly kind: 'tree-depth'; readonly team: string; readonly level: number }
  | { readonly kind: 'tree-children'; readonly team: string; readonly children: readonly string[] };

/** A session name more than one team uses: Claude Code session names are machine-wide. */
export interface NameClash {
  readonly name: string;
  readonly holders: readonly SessionAddress[];
}

/** One team in a walk down the tree, with how many levels below the walk's first team it is. */
export interface TreeStep {
  readonly team: string;
  readonly depth: number;
}

/** Where a team sits in its tree, for the rule its sessions get at SessionStart. */
export interface TreePlace {
  /** The tree's root team: its lead is the one lead the user talks to. */
  readonly root: string;
  /** The parent team's lead and the name to message it by; undefined for the root. */
  readonly parentLead: (SessionAddress & { readonly name: string }) | undefined;
  /** The teams right under this one, by id. */
  readonly children: readonly string[];
}

/** A team's chain of parents: up to its root, to a parent with no config, or round a loop. */
interface Chain {
  readonly teams: readonly string[];
  /** The teams in the loop the chain runs into, when it does. */
  readonly loop: readonly string[] | undefined;
}

export class TeamTree {
  private readonly nodes: ReadonlyMap<string, TeamNode>;

  constructor(nodes: Iterable<TeamNode>) {
    this.nodes = new Map([...nodes].map((node) => [node.team, node]));
  }

  /** Every team, by id. */
  get teams(): string[] {
    return [...this.nodes.keys()].sort();
  }

  node(team: string): TeamNode | undefined {
    return this.nodes.get(team);
  }

  leadOf(team: string): string | undefined {
    return this.nodes.get(team)?.lead;
  }

  /** The parent team, when the team names one that has a config. */
  parentOf(team: string): string | undefined {
    const parent = this.nodes.get(team)?.parent;
    return parent !== undefined && this.nodes.has(parent) ? parent : undefined;
  }

  /** The parent team's lead as `{ team, id }`, when the team has a parent with a config. */
  parentLeadOf(team: string): SessionAddress | undefined {
    const parent = this.nodes.get(this.nodes.get(team)?.parent ?? '');
    return parent === undefined ? undefined : { team: parent.team, id: parent.lead };
  }

  childrenOf(team: string): string[] {
    return this.teams.filter((child) => this.nodes.get(child)?.parent === team);
  }

  /** The tree's root above a team; undefined when its parents go round a loop. */
  rootOf(team: string): string | undefined {
    const chain = this.chain(team);
    return chain.loop === undefined ? chain.teams.at(-1) : undefined;
  }

  /** The team's level, its root being 1; undefined when its parents go round a loop. */
  levelOf(team: string): number | undefined {
    const chain = this.chain(team);
    return chain.loop === undefined ? chain.teams.length : undefined;
  }

  /** Whether two teams hang in one tree: their chains of parents meet. */
  sameTree(a: string, b: string): boolean {
    const above = this.chain(a).teams;
    return this.chain(b).teams.some((team) => above.includes(team));
  }

  /** The team, then every team below it, depth first and children by id; a loop is walked once. */
  walk(team: string): TreeStep[] {
    const steps: TreeStep[] = [];
    const visit = (current: string, depth: number): void => {
      if (steps.some((step) => step.team === current)) {
        return;
      }
      steps.push({ team: current, depth });
      this.childrenOf(current).forEach((child) => visit(child, depth + 1));
    };
    visit(team, 0);
    return steps;
  }

  /**
   * Where the team sits: its root, its parent's lead and its child teams. Undefined for a team on its
   * own (no parent, no child team) and for one whose parents go round a loop, which `doctor` names.
   */
  placeOf(team: string): TreePlace | undefined {
    const root = this.rootOf(team);
    const parent = this.nodes.get(this.parentOf(team) ?? '');
    const children = this.childrenOf(team);
    if (root === undefined || (parent === undefined && children.length === 0)) {
      return undefined;
    }
    const parentLead = parent === undefined ? undefined : { team: parent.team, id: parent.lead, name: parent.names.get(parent.lead) ?? parent.lead };
    return { root, parentLead, children };
  }

  /** Every team below this one, depth first. */
  descendantsOf(team: string): string[] {
    return this.walk(team)
      .slice(1)
      .map((step) => step.team);
  }

  /** The tree with one team added, or replaced when it is there already. */
  with(node: TeamNode): TeamTree {
    return new TeamTree([...[...this.nodes.values()].filter((other) => other.team !== node.team), node]);
  }

  /** The problems in the team's own tree: those of a team that shares a tree with it. */
  problemsOf(team: string): TreeProblem[] {
    return this.problems().filter((problem) => (problem.kind === 'tree-loop' ? problem.teams : [problem.team]).some((other) => this.sameTree(other, team)));
  }

  /** The session names the team shares with another team. */
  nameClashesOf(team: string): NameClash[] {
    return this.nameClashes().filter((clash) => clash.holders.some((holder) => holder.team === team));
  }

  /** What breaks the tree's rules, team by team in id order. */
  problems(): TreeProblem[] {
    const problems: TreeProblem[] = [];
    const loops = new Map<string, readonly string[]>();
    for (const team of this.teams) {
      const node = this.nodes.get(team);
      if (node?.statedId !== undefined && node.statedId !== team) {
        problems.push({ kind: 'tree-id', team, stated: node.statedId });
      }
      if (node?.parent !== undefined && !this.nodes.has(node.parent)) {
        problems.push({ kind: 'tree-parent', team, parent: node.parent });
      }
      const { teams, loop } = this.chain(team);
      if (loop !== undefined) {
        const members = [...loop].sort();
        loops.set(members.join(','), members);
      } else if (teams.length === TREE_LIMITS.levels + 1) {
        // Only the top team of a too-deep branch: moving it fixes every team below it.
        problems.push({ kind: 'tree-depth', team, level: teams.length });
      }
      const children = this.childrenOf(team);
      if (children.length > TREE_LIMITS.childTeams) {
        problems.push({ kind: 'tree-children', team, children });
      }
    }
    for (const teams of loops.values()) {
      problems.push({ kind: 'tree-loop', teams });
    }
    return problems;
  }

  /** Session names two or more teams use, by name. */
  nameClashes(): NameClash[] {
    const holders = new Map<string, SessionAddress[]>();
    for (const node of this.nodes.values()) {
      for (const [id, name] of node.names) {
        holders.set(name, [...(holders.get(name) ?? []), { team: node.team, id }]);
      }
    }
    return [...holders]
      .filter(([, held]) => new Set(held.map((holder) => holder.team)).size > 1)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, held]) => ({ name, holders: held.sort((a, b) => a.team.localeCompare(b.team)) }));
  }

  private chain(team: string): Chain {
    const teams: string[] = [];
    let current = this.nodes.get(team);
    while (current !== undefined) {
      const at = teams.indexOf(current.team);
      if (at !== -1) {
        return { teams, loop: teams.slice(at) };
      }
      teams.push(current.team);
      current = current.parent === undefined ? undefined : this.nodes.get(current.parent);
    }
    return { teams, loop: undefined };
  }
}

/** One line on a tree problem and its fix, for `doctor` and for a refused `team create`. */
export function describeTreeProblem(problem: TreeProblem, command: string): string {
  switch (problem.kind) {
    case 'tree-id':
      return `team ${problem.team}'s config says team.id "${problem.stated}", but its folder is ${problem.team}: set team.id to ${problem.team}`;
    case 'tree-parent':
      return `team ${problem.team} names parent ${problem.parent}, which has no team config: create it with \`${command} team create ${problem.parent}\`, or fix team.parent`;
    case 'tree-loop':
      return `teams ${problem.teams.join(', ')} name each other as parents in a loop, so none of them reaches a root: fix team.parent in one of them`;
    case 'tree-depth':
      return `team ${problem.team} is at level ${problem.level} of its tree, and a tree has at most ${TREE_LIMITS.levels} levels: hang it under a team nearer the root`;
    case 'tree-children':
      return `team ${problem.team} has ${problem.children.length} child teams (${problem.children.join(', ')}), and a team has at most ${TREE_LIMITS.childTeams}: hang some under another team`;
  }
}

/** One line on a session name two teams use. */
export function describeNameClash(clash: NameClash, command: string): string {
  const holders = clash.holders.map((holder) => `${holder.team}/${holder.id}`).join(', ');
  return `${clash.name} is the session name of ${holders}: Claude Code session names are machine-wide, so messages by that name can reach the wrong team; give one a new name with \`${command} rename\``;
}
