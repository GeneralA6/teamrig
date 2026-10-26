import { resolve } from 'node:path';
import { LeadTree } from "../../config/lead-tree.js";
import { ENV } from "../../core/home.js";
import { resolveTeam } from "../../core/team.js";
import { JsonlEventLog } from "../../register/store.js";
import { removalRefusal } from "../../worktree/owner.js";
import { carryOut, describePlan, planRemoval } from "../../worktree/remove.js";
import { onePositional, UsageError } from "../args.js";
import { openKit, requireConfig, rosterOf, teamFolders } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { tabSessionOf } from "./tab-session.js";
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
async function callerRefusal(args, runtime, branch) {
    const found = await resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [runtime.cwd]));
    if (found.kind === 'none') {
        return undefined;
    }
    if (found.kind === 'broken') {
        throw new RefusedError(`${found.from} ${found.problem}`);
    }
    const kit = await openKit(runtime, found.team);
    const config = requireConfig(kit, runtime, 'read');
    const caller = await tabSessionOf(args, runtime, kit, await rosterOf(runtime, kit, config), 'removes worktrees only as itself');
    if (caller === undefined) {
        const inClaudeCode = (runtime.env[ENV.claudeSession]?.trim() ?? '') !== '';
        return inClaudeCode ? `this Claude Code tab is bound to no session of team ${found.team}: give --session <id|name>` : undefined;
    }
    const { state } = await new JsonlEventLog(runtime.files, kit.paths.events).read();
    return removalRefusal({ caller, branch, ownerOf: (task) => state.tasks.get(task)?.owner, tree: new LeadTree(config) });
}
