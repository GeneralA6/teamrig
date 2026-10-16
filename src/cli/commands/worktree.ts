import { resolve } from 'node:path';
import { carryOut, describePlan, planRemoval } from '../../worktree/remove.ts';
import { onePositional, UsageError, type ParsedArgs } from '../args.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';

/**
 * `worktree remove <path> [--delete-branch [--base <ref>]] [--dry-run]`: removes a linked git worktree. Each link in
 * it, such as a `node_modules` junction to the main checkout's, is unlinked and seen gone before `git worktree
 * remove` runs, which on Windows would follow the link and empty its target. Anything unsafe is REFUSED, exit 2,
 * before a change: the main checkout, a dirty tree, a real `node_modules` folder, and, for `--delete-branch`, a
 * branch with a commit not on its base. A step that fails partway is FAILED, naming what was already done.
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
