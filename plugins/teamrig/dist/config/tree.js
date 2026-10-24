import { TREE_LIMITS } from "./limits.js";
/** The node of a team, from its folder name, its config and its roster with the renames applied. */
export function teamNodeOf(team, config, roster) {
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
 * Whom a team's lead asks for what the owner approves: the owner in a root team. A child team's lead asks its parent
 * team's lead, who takes it up to the owner; it never goes to the owner directly.
 */
export function ownerAsk(config) {
    const parent = config.team?.parent;
    return parent === undefined ? 'the owner' : `the lead of team ${parent}, who takes it to the owner`;
}
export class TeamTree {
    nodes;
    constructor(nodes) {
        this.nodes = new Map([...nodes].map((node) => [node.team, node]));
    }
    /** Every team, by id. */
    get teams() {
        return [...this.nodes.keys()].sort();
    }
    node(team) {
        return this.nodes.get(team);
    }
    leadOf(team) {
        return this.nodes.get(team)?.lead;
    }
    /** The parent team, when the team names one that has a config. */
    parentOf(team) {
        const parent = this.nodes.get(team)?.parent;
        return parent !== undefined && this.nodes.has(parent) ? parent : undefined;
    }
    /** The parent team's lead as `{ team, id }`, when the team has a parent with a config. */
    parentLeadOf(team) {
        const parent = this.nodes.get(this.nodes.get(team)?.parent ?? '');
        return parent === undefined ? undefined : { team: parent.team, id: parent.lead };
    }
    childrenOf(team) {
        return this.teams.filter((child) => this.nodes.get(child)?.parent === team);
    }
    /** The tree's root above a team; undefined when its parents go round a loop. */
    rootOf(team) {
        const chain = this.chain(team);
        return chain.loop === undefined ? chain.teams.at(-1) : undefined;
    }
    /** The team's level, its root being 1; undefined when its parents go round a loop. */
    levelOf(team) {
        const chain = this.chain(team);
        return chain.loop === undefined ? chain.teams.length : undefined;
    }
    /** Whether two teams hang in one tree: their chains of parents meet. */
    sameTree(a, b) {
        const above = this.chain(a).teams;
        return this.chain(b).teams.some((team) => above.includes(team));
    }
    /** The team, then every team below it, depth first and children by id; a loop is walked once. */
    walk(team) {
        const steps = [];
        const visit = (current, depth) => {
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
    placeOf(team) {
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
    descendantsOf(team) {
        return this.walk(team)
            .slice(1)
            .map((step) => step.team);
    }
    /** The tree with one team added, or replaced when it is there already. */
    with(node) {
        return new TeamTree([...[...this.nodes.values()].filter((other) => other.team !== node.team), node]);
    }
    /** The problems in the team's own tree: those of a team that shares a tree with it. */
    problemsOf(team) {
        return this.problems().filter((problem) => (problem.kind === 'tree-loop' ? problem.teams : [problem.team]).some((other) => this.sameTree(other, team)));
    }
    /** The session names the team shares with another team. */
    nameClashesOf(team) {
        return this.nameClashes().filter((clash) => clash.holders.some((holder) => holder.team === team));
    }
    /** What breaks the tree's rules, team by team in id order. */
    problems() {
        const problems = [];
        const loops = new Map();
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
            }
            else if (teams.length === TREE_LIMITS.levels + 1) {
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
    nameClashes() {
        const holders = new Map();
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
    chain(team) {
        const teams = [];
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
export function describeTreeProblem(problem, command) {
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
export function describeNameClash(clash, command) {
    const holders = clash.holders.map((holder) => `${holder.team}/${holder.id}`).join(', ');
    return `${clash.name} is the session name of ${holders}: Claude Code session names are machine-wide, so messages by that name can reach the wrong team; give one a new name with \`${command} rename\``;
}
