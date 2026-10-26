import { isRole, roleHolderOf } from "../../config/roster.js";
import { formatAddress, splitAddress } from "../../core/address.js";
import { KIT_NAME } from "../../core/home.js";
import { recordRename } from "../../names/record.js";
import { UsageError } from "../args.js";
import { callerOf } from "../inputs.js";
import { findTeam, openTeamKit, renameDepsOf, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { loadTree } from "../tree.js";
/** One roster line: `<id> <name>`, then the roles the session holds, then the names it had before. */
function rosterLine(roster, id) {
    const roles = roster.rolesOf(id);
    const former = roster.formerNamesOf(id);
    const rolesText = roles.length === 0 ? '' : ` (${roles.join(', ')})`;
    const formerText = former.length === 0 ? '' : `, formerly ${former.join(', ')}`;
    return `${id} ${roster.nameOf(id) ?? id}${rolesText}${formerText}`;
}
/**
 * A session by id or name, else the holder of a role, so `who lead` works whatever the lead's id; a role the team
 * leaves to a team above (`<team>/<id>`, T1143) gives its holder there.
 */
function addressOf(roster, roles, text, team) {
    const found = roster.lookup(text);
    if (found.ok || !isRole(text)) {
        return { team, id: sessionIdOf(roster, text) };
    }
    const holder = roleHolderOf(roles, text, team);
    if (holder === undefined) {
        throw new RefusedError(`no session holds the ${text} role`);
    }
    return holder;
}
/** The name to message a session by, from its own team's roster; `<team>/<id>` when that team has no config to read. */
async function nameAt(runtime, roster, address, team) {
    if (address.team === team) {
        return roster.nameOf(address.id) ?? address.id;
    }
    const { teams } = await loadTree(runtime);
    return teams.get(address.team)?.roster.nameOf(address.id) ?? formatAddress(address);
}
/**
 * The name of a session of another team of the caller's tree (T1276), found by its id or any name it has had there; a
 * team of a separate tree, or one with no config to read, is refused.
 */
async function treeNameOf(runtime, own, team, session) {
    const { tree, teams } = await loadTree(runtime);
    const other = teams.get(team);
    if (other === undefined || !tree.sameTree(own, team)) {
        throw new RefusedError(`team ${team} is not in the tree of team ${own}; who names the sessions of its own tree`);
    }
    const found = other.roster.lookup(session);
    if (!found.ok) {
        throw new RefusedError(`team ${team}: ${found.error}`);
    }
    return other.roster.nameOf(found.id) ?? found.id;
}
/** `who [<id|name|role|team/id>]`: the name to message a session by; with no argument, every session of the team. */
export async function who(args, runtime) {
    const [text, extra] = args.positionals;
    if (extra !== undefined) {
        throw new UsageError(`unexpected "${extra}"`);
    }
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const roster = await rosterOf(runtime, kit, config);
    if (text === undefined) {
        roster.ids.forEach((id) => runtime.out.stdout(rosterLine(roster, id)));
        return EXIT.ok;
    }
    const typed = splitAddress(text);
    if (typed?.team !== undefined && typed.team !== kit.paths.team) {
        runtime.out.stdout(await treeNameOf(runtime, kit.paths.team, typed.team, typed.session));
        return EXIT.ok;
    }
    const address = addressOf(roster, config.roles, typed?.session ?? text, kit.paths.team);
    runtime.out.stdout(await nameAt(runtime, roster, address, kit.paths.team));
    return EXIT.ok;
}
/** `<id> (<name>)`: the id addresses the session as `<team>/<id>`, the name is what Claude Code calls it. */
function sessionText(node, id) {
    return `${id} (${node.names.get(id) ?? id})`;
}
/** One team of the tree: indented by its level below the root, its lead, then its members. */
function treeLine(node, depth, own) {
    const members = node.sessions.filter((id) => id !== node.lead).map((id) => sessionText(node, id));
    const here = own ? ' (this team)' : '';
    const membersText = members.length === 0 ? '' : `; members ${members.join(', ')}`;
    return `${'  '.repeat(depth)}${node.team}${here}: lead ${sessionText(node, node.lead)}${membersText}`;
}
/**
 * `team tree`: the tree the command's team hangs in, from its root down, each team with its lead and
 * members. A broken tree (a loop of parents, a missing parent, a team too deep) is shown as far as it
 * reads, with a pointer to `doctor`.
 */
export async function teamTree(args, runtime) {
    const [extra] = args.positionals;
    if (extra !== undefined) {
        throw new UsageError(`unexpected "${extra}"`);
    }
    const { team } = await findTeam(runtime);
    const { tree } = await loadTree(runtime);
    if (tree.node(team) === undefined) {
        throw new RefusedError(`no team config for team ${team}; create it with: ${KIT_NAME} team create ${team} --sessions <id,id>`);
    }
    const root = tree.rootOf(team) ?? team;
    const steps = tree.walk(root);
    runtime.out.stdout(`TREE ${root}, ${steps.length} team(s)`);
    for (const step of steps) {
        const node = tree.node(step.team);
        if (node !== undefined) {
            runtime.out.stdout(treeLine(node, step.depth, step.team === team));
        }
    }
    const inTree = new Set(steps.map((step) => step.team));
    const broken = tree.problems().filter((problem) => (problem.kind === 'tree-loop' ? problem.teams : [problem.team]).some((id) => inTree.has(id)));
    if (broken.length > 0) {
        runtime.out.stderr(`WARN the tree has ${broken.length} problem(s); run: ${KIT_NAME} doctor`);
    }
    return EXIT.ok;
}
/**
 * `rename <id|name> <new-name>`: records a session's new name in the rename log. Nothing is moved:
 * the id keys every file, and each name the session had keeps finding it. Only the session itself
 * or the lead may record it.
 */
export async function rename(args, runtime) {
    const [target, to, extra] = args.positionals;
    if (target === undefined || to === undefined) {
        throw new UsageError('rename needs <id|name> and <new-name>');
    }
    if (extra !== undefined) {
        throw new UsageError(`unexpected "${extra}"`);
    }
    const caller = callerOf(args.flags, runtime.env);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'write');
    const roster = await rosterOf(runtime, kit, config);
    const id = sessionIdOf(roster, target);
    const by = sessionIdOf(roster, caller);
    const outcome = await recordRename(renameDepsOf(runtime, kit, config), { id, to, by });
    if (outcome.kind === 'refused') {
        throw new RefusedError(outcome.reason);
    }
    if (outcome.kind === 'unchanged') {
        runtime.out.stdout(`UNCHANGED ${id} is already called ${to}`);
        return EXIT.ok;
    }
    const { from } = outcome.rename;
    runtime.out.stdout(`RENAMED ${id}: ${from} -> ${to}`);
    runtime.out.stdout(`NOTE ${from} still finds ${id} in every ${KIT_NAME} command; ${KIT_NAME} never edits permission or auto-mode rules, so update any that name ${from} yourself`);
    return EXIT.ok;
}
