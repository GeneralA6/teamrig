import { resolve } from 'node:path';
import { DEFAULT_WORKTREE_FOLDER } from "../../config/defaults.js";
import { LeadTree } from "../../config/lead-tree.js";
import { teamPlace } from "../../delivery/places.js";
import { ENV } from "../../core/home.js";
import { samePath } from "../../core/paths.js";
import { resolveTeam } from "../../core/team.js";
import { classOf } from "../../register/focus.js";
import { itemTypeOf } from "../../register/item-types.js";
import { JsonlEventLog } from "../../register/store.js";
import { createWorktree } from "../../worktree/add.js";
import { isBranchType, taskBranchName } from "../../worktree/branch-name.js";
import { removalRefusal } from "../../worktree/owner.js";
import { carryOut, clearLeftover, describeLeftover, describePlan, planRemoval } from "../../worktree/remove.js";
import { onePositional, UsageError } from "../args.js";
import { taskIdOf } from "../inputs.js";
import { openKit, requireConfig, rosterOf, teamFolders } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { tabSessionOf } from "./tab-session.js";
/**
 * `worktree add <branch> | --task <T id> [--type <branch type>] [--repo <name>]`: makes a session's worktree the same
 * way every time (worktree/add.ts): a new branch from the remote's newest default branch, in the repository's worktree
 * folder, then its setup run there. With `--task` the branch is named from the task by the team's delivery.branches
 * (worktree/branch-name.ts, T2690). The repository is the one `--repo` names in delivery.repos, else the one the folder
 * it runs in belongs to, with the folder and setup of the delivery.repos entry that lists its main checkout. REFUSED,
 * exit 2, before any change; a fetch, a `git worktree add` or a setup that fails is FAILED, exit 1.
 */
export async function add(args, runtime) {
    const team = await teamAt(runtime);
    const branch = await branchToAdd(args, runtime, team);
    const place = addPlace(args.flags.get('repo'), runtime, team);
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
/** The branch `worktree add` makes: the one given, or with `--task` the one the team's delivery.branches names for that task. */
async function branchToAdd(args, runtime, team) {
    const taskText = args.flags.get('task');
    const type = args.flags.get('type');
    if (taskText === undefined) {
        if (type !== undefined) {
            throw new UsageError('--type sets the branch type of the branch --task names: give --task too');
        }
        return onePositional(args, 'branch');
    }
    const [given] = args.positionals;
    if (given !== undefined) {
        throw new UsageError(`give a branch name or --task, not both ("${given}")`);
    }
    if (type !== undefined && !isBranchType(type)) {
        throw new UsageError(`--type ${type}: expected a branch type, a lowercase letter then lowercase letters and digits, such as feat or fix`);
    }
    const id = taskIdOf(taskText);
    if (team === undefined) {
        throw new RefusedError(`--task names a task on a team's register, and ${runtime.cwd} is in no team: give a branch name instead`);
    }
    const { state } = await new JsonlEventLog(runtime.files, team.kit.paths.events).read();
    const task = state.tasks.get(id);
    if (task === undefined) {
        throw new RefusedError(`team ${team.name}'s register has no ${id}`);
    }
    const { config } = team;
    const named = taskBranchName({ id, title: task.title, owner: task.owner, ref: task.ref, itemType: itemTypeOf(task), workClass: classOf(task, config.focus) }, config.delivery.branches, type);
    if (named.kind === 'refused') {
        throw new RefusedError(named.reason);
    }
    return named.branch;
}
function addPlace(repo, runtime, team) {
    const repos = reposOf(team);
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
function placeOf(mainCheckout, config) {
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
export async function remove(args, runtime) {
    const path = resolve(runtime.cwd, onePositional(args, 'path'));
    const deleteBranch = args.switches.has('delete-branch');
    const base = args.flags.get('base');
    if (base !== undefined && !deleteBranch) {
        throw new UsageError('--base names the branch to check against for --delete-branch: give both, or neither');
    }
    const team = await teamAt(runtime);
    const decision = await planRemoval({ path, cwd: runtime.cwd, deleteBranch, base, worktreeFolders: worktreeFolders(runtime, team) }, runtime.worktrees);
    if (decision.kind === 'refused') {
        throw new RefusedError(decision.reason);
    }
    if (decision.kind === 'leftover') {
        // No session check: a leftover has no branch to own and holds only links and empty folders, nothing to lose (T1051).
        if (args.switches.has('dry-run')) {
            for (const line of describeLeftover(decision.plan)) {
                runtime.out.stdout(line);
            }
            runtime.out.stdout('dry run: nothing changed');
            return EXIT.ok;
        }
        await clearLeftover(decision.plan, runtime.worktrees.files, (line) => runtime.out.stdout(line));
        runtime.out.stdout(`OK cleared the leftover ${decision.plan.top}`);
        return EXIT.ok;
    }
    const refusal = await callerRefusal(args, runtime, team, decision.plan);
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
 * Why the caller may not carry out `plan`, or undefined when it may: in a team, a session removes its own worktrees,
 * those of the sessions it leads, and a merged one on a detached HEAD (owner.ts). Nothing is checked outside a team,
 * nor for the person at a terminal outside Claude Code who names no session; a Claude Code tab bound to no session must
 * name one.
 */
async function callerRefusal(args, runtime, team, { onBranch, mergedInto }) {
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
    return removalRefusal({ caller, branch: onBranch, mergedInto, ownerOf: (task) => state.tasks.get(task)?.owner, tree: new LeadTree(config) });
}
/** The folders worktrees are made in: each of the team's delivery.repos, and the one of the repository the command runs in. */
function worktreeFolders(runtime, team) {
    const repos = reposOf(team);
    const places = repos.map((entry) => placeOf(entry.mainDir, entry.config));
    const [main] = runtime.worktrees.git.worktrees(runtime.cwd) ?? [];
    if (main !== undefined) {
        places.push(placeOf(main.path, repos.find((entry) => samePath(entry.mainDir, main.path, runtime.platform))?.config));
    }
    return places.map(({ folder, mainDir }) => ({ folder, mainDir }));
}
/** The team's delivery.repos entries, each with its main checkout resolved; none outside a team. */
function reposOf(team) {
    return team === undefined ? [] : Object.entries(team.config.delivery.repos).map(([name, config]) => ({ name, config, mainDir: teamPlace(team.kit.paths, config.mainCheckout) }));
}
/** The team the folder the command runs in belongs to, with its kit and config; undefined outside a team. */
async function teamAt(runtime) {
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
