import { resolve } from 'node:path';
import { DEFAULT_WORKTREE_FOLDER } from '../../config/defaults.ts';
import { LeadTree } from '../../config/lead-tree.ts';
import type { CoordinatorRepoConfig, KitConfig } from '../../config/types.ts';
import { teamPlace } from '../../coordinator/places.ts';
import { ENV } from '../../core/home.ts';
import { samePath } from '../../core/paths.ts';
import { resolveTeam } from '../../core/team.ts';
import { JsonlEventLog } from '../../register/store.ts';
import { createWorktree, type AddRequest } from '../../worktree/add.ts';
import { removalRefusal } from '../../worktree/owner.ts';
import { carryOut, describePlan, planRemoval } from '../../worktree/remove.ts';
import { onePositional, UsageError, type ParsedArgs } from '../args.ts';
import { openKit, requireConfig, rosterOf, teamFolders, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { tabSessionOf } from './tab-session.ts';

/**
 * `worktree add <branch> [--repo <name>]`: makes a session's worktree the same way every time (worktree/add.ts): a new
 * branch from the remote's newest default branch, in the repository's worktree folder, then its setup run there. The
 * repository is the one `--repo` names in delivery.repos, else the one the folder it runs in belongs to, with the
 * folder and setup of the delivery.repos entry that lists its main checkout. REFUSED, exit 2, before any change; a
 * fetch, a `git worktree add` or a setup that fails is FAILED, exit 1.
 */
export async function add(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const branch = onePositional(args, 'branch');
  const place = await addPlace(args.flags.get('repo'), runtime);
  const { git, files } = runtime.worktrees;
  const end = await createWorktree({ branch, ...place, env: runtime.env }, { git, files, hooks: runtime.hooks }, (line) => runtime.out.stdout(line));
  switch (end.kind) {
    case 'refused':
      throw new RefusedError(end.reason);
    case 'failed':
      runtime.out.stdout(`FAILED ${end.reason}`);
      return EXIT.failed;
    case 'added':
      runtime.out.stdout(`OK added ${end.path}`);
      return EXIT.ok;
  }
}

/** Where `worktree add` makes a worktree: the main checkout git runs in, the folder, and the setup run in it. */
type AddPlace = Pick<AddRequest, 'mainDir' | 'folder' | 'setup'>;

async function addPlace(repo: string | undefined, runtime: CliRuntime): Promise<AddPlace> {
  const team = await teamAt(runtime);
  const repos = team === undefined ? [] : Object.entries(team.config.delivery.repos).map(([name, config]) => ({ name, config, mainDir: teamPlace(team.kit.paths, config.mainCheckout) }));
  if (repo !== undefined) {
    if (team === undefined) {
      throw new RefusedError(`--repo names a repository in a team's delivery.repos, and ${runtime.cwd} is in no team: run it in the repository instead`);
    }
    const listed = repos.find((entry) => entry.name === repo);
    if (listed === undefined) {
      const names = repos.map((entry) => entry.name);
      throw new RefusedError(`team ${team.name} has no delivery.repos.${repo}${names.length === 0 ? '' : `: it lists ${names.join(', ')}`}`);
    }
    return placeOf(listed.mainDir, listed.config);
  }
  const [main] = runtime.worktrees.git.worktrees(runtime.cwd) ?? [];
  if (main === undefined) {
    throw new RefusedError(`${runtime.cwd} is in no git repository: run it in one, or give --repo <name>`);
  }
  return placeOf(main.path, repos.find((entry) => samePath(entry.mainDir, main.path, runtime.platform))?.config);
}

/** A repository's place by its main checkout, with its delivery.repos entry's folder and setup; the default folder and no setup without one. */
function placeOf(mainCheckout: string, config: CoordinatorRepoConfig | undefined): AddPlace {
  const mainDir = resolve(mainCheckout);
  return { mainDir, folder: resolve(mainDir, config?.worktreeFolder ?? DEFAULT_WORKTREE_FOLDER), setup: config?.worktreeSetup };
}

/**
 * `worktree remove <path> [--delete-branch [--base <ref>]] [--dry-run] [--session <id|name>]`: removes a linked git
 * worktree. Each link in it, such as a `node_modules` junction to the main checkout's, is unlinked and seen gone before
 * `git worktree remove` runs, which on Windows would follow the link and empty its target. Anything unsafe is REFUSED,
 * exit 2, before a change: the main checkout, a dirty tree, a real `node_modules` folder, for `--delete-branch` a
 * branch with a commit not on its base, and in a team another session's worktree (`callerRefusal`). A step that fails
 * partway is FAILED, naming what was already done.
 */
export async function remove(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const path = resolve(runtime.cwd, onePositional(args, 'path'));
  const deleteBranch = args.switches.has('delete-branch');
  const base = args.flags.get('base');
  if (base !== undefined && !deleteBranch) {
    throw new UsageError('--base names the branch to check against for --delete-branch: give both, or neither');
  }
  const decision = await planRemoval({ path, cwd: runtime.cwd, deleteBranch, base }, runtime.worktrees);
  if (decision.kind === 'refused') {
    throw new RefusedError(decision.reason);
  }
  const refusal = await callerRefusal(args, runtime, decision.plan.onBranch);
  if (refusal !== undefined) {
    throw new RefusedError(refusal);
  }
  if (args.switches.has('dry-run')) {
    for (const line of describePlan(decision.plan)) {
      runtime.out.stdout(line);
    }
    runtime.out.stdout('dry run: nothing changed');
    return EXIT.ok;
  }
  await carryOut(decision.plan, runtime.worktrees, (line) => runtime.out.stdout(line));
  runtime.out.stdout(`OK removed ${decision.plan.top}`);
  return EXIT.ok;
}

/**
 * Why the caller may not remove a worktree on `branch`, or undefined when it may: in a team, a session removes its own
 * worktrees and those of the sessions it leads (owner.ts). Nothing is checked outside a team, nor for the person at a
 * terminal outside Claude Code who names no session; a Claude Code tab bound to no session must name one.
 */
async function callerRefusal(args: ParsedArgs, runtime: CliRuntime, branch: string | undefined): Promise<string | undefined> {
  const team = await teamAt(runtime);
  if (team === undefined) {
    return undefined;
  }
  const { kit, config } = team;
  const caller = await tabSessionOf(args, runtime, kit, await rosterOf(runtime, kit, config), 'removes worktrees only as itself');
  if (caller === undefined) {
    const inClaudeCode = (runtime.env[ENV.claudeSession]?.trim() ?? '') !== '';
    return inClaudeCode ? `this Claude Code tab is bound to no session of team ${team.name}: give --session <id|name>` : undefined;
  }
  const { state } = await new JsonlEventLog(runtime.files, kit.paths.events).read();
  return removalRefusal({ caller, branch, ownerOf: (task) => state.tasks.get(task)?.owner, tree: new LeadTree(config) });
}

/** The team the folder the command runs in belongs to, with its kit and config; undefined outside a team. */
async function teamAt(runtime: CliRuntime): Promise<{ readonly name: string; readonly kit: Kit; readonly config: KitConfig } | undefined> {
  const found = await resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [runtime.cwd]));
  if (found.kind === 'none') {
    return undefined;
  }
  if (found.kind === 'broken') {
    throw new RefusedError(`${found.from} ${found.problem}`);
  }
  const kit = await openKit(runtime, found.team);
  return { name: found.team, kit, config: requireConfig(kit, runtime, 'read') };
}
