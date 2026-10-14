import { isRole, type Roster } from '../../config/roster.ts';
import type { TeamNode } from '../../config/tree.ts';
import { KIT_NAME } from '../../core/home.ts';
import { recordRename } from '../../names/record.ts';
import { UsageError, type ParsedArgs } from '../args.ts';
import { callerOf } from '../inputs.ts';
import { findTeam, openTeamKit, renameDepsOf, requireConfig, rosterOf, sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';

/** One roster line: `<id> <name>`, then the roles the session holds, then the names it had before. */
function rosterLine(roster: Roster, id: string): string {
  const roles = roster.rolesOf(id);
  const former = roster.formerNamesOf(id);
  const rolesText = roles.length === 0 ? '' : ` (${roles.join(', ')})`;
  const formerText = former.length === 0 ? '' : `, formerly ${former.join(', ')}`;
  return `${id} ${roster.nameOf(id) ?? id}${rolesText}${formerText}`;
}

/** A session by id or name, else the holder of a role, so `who lead` works whatever the lead's id. */
function idOf(roster: Roster, text: string): string {
  const found = roster.lookup(text);
  if (found.ok || !isRole(text)) {
    return sessionIdOf(roster, text);
  }
  const holder = roster.holderOf(text);
  if (holder === undefined) {
    throw new RefusedError(`no session holds the ${text} role`);
  }
  return holder;
}

/** `who [<id|name|role>]`: the name to message a session by; with no argument, every session. */
export async function who(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const [text, extra] = args.positionals;
  if (extra !== undefined) {
    throw new UsageError(`unexpected "${extra}"`);
  }
  const kit = await openTeamKit(runtime);
  const roster = await rosterOf(runtime, kit, requireConfig(kit, runtime, 'read'));
  if (text === undefined) {
    roster.ids.forEach((id) => runtime.out.stdout(rosterLine(roster, id)));
    return EXIT.ok;
  }
  const id = idOf(roster, text);
  runtime.out.stdout(roster.nameOf(id) ?? id);
  return EXIT.ok;
}

/** `<id> (<name>)`: the id addresses the session as `<team>/<id>`, the name is what Claude Code calls it. */
function sessionText(node: TeamNode, id: string): string {
  return `${id} (${node.names.get(id) ?? id})`;
}

/** One team of the tree: indented by its level below the root, its lead, then its members. */
function treeLine(node: TeamNode, depth: number, own: boolean): string {
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
export async function teamTree(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
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
export async function rename(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
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
  runtime.out.stdout(
    `NOTE ${from} still finds ${id} in every ${KIT_NAME} command; ${KIT_NAME} never edits permission or auto-mode rules, so update any that name ${from} yourself`,
  );
  return EXIT.ok;
}
