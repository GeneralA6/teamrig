import { LeadTree } from '../../config/lead-tree.ts';
import type { KitConfig } from '../../config/types.ts';
import { formatAddress } from '../../core/address.ts';
import { errorMessage } from '../../core/guards.ts';
import { checkClient, clientRootOf } from '../../exec/client-integrity.ts';
import { ClientInstalls, ShellPathSearch } from '../../exec/client-launch.ts';
import { execGuardOutput, type TabIdentity } from '../../hooks/exec-guard.ts';
import { packageGuardOf, packageGuardOutput } from '../../hooks/package-guard.ts';
import { hookAsksOf } from '../../hooks/permission.ts';
import { commitsOf, protectedBranchesOf, pushGuardOutput, pushToProtectedOf, skipHooksOf, type PushClearance } from '../../hooks/push-guard.ts';
import { secretGuardOf, secretGuardOutput, secretPatternsOf } from '../../hooks/secret-guard.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import { approvedTaskOf } from '../../register/approval.ts';
import { JsonlEventLog } from '../../register/store.ts';
import { secretRulesOf } from '../../secret-guard/rules.ts';
import { rosterOf, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { leadAboveOf } from '../tree.ts';
import type { GuardLoad } from './hook-guard-load.ts';
import { teamSessionOf } from './hook-input.ts';

/**
 * The PreToolUse guards' answers for one call, each built from the hook's runtime and the team's config load the same
 * way its own hook builds it: '' when the guard lets the call go, else the hook output that asks or refuses. Shared by
 * each guard's hook and by any hook that must know every guard passed on the same call.
 */

/**
 * Under `pushToProtected: lead` or `gated`, what lets this tab's normal push to a protected branch through (T684): the
 * lead's own push, else a waiting task of its session's that a leader above it approved (T781), read lock-free from the
 * register. A child team's lead is no lead of the whole tree: its push needs the parent team's lead's approval (T1140).
 * It never throws: a register or tree it cannot read clears nothing, so the push is refused, saying why.
 */
async function pushClearanceOf(runtime: CliRuntime, kit: Kit | undefined, payload: unknown): Promise<PushClearance> {
  if (kit === undefined || kit.load.status !== 'loaded') {
    // Not reached: without a loaded config the guard asks (pushToProtectedOf), so it never reads the clearance.
    return { kind: 'none', approver: 'the lead', why: 'the team config did not load' };
  }
  const { config } = kit.load;
  const lead = config.roles.lead;
  const tree = new LeadTree(config);
  try {
    const roster = await rosterOf(runtime, kit, config);
    const session = await teamSessionOf(runtime, kit, roster, sessionIdOf(payload));
    if (session === undefined) {
      return { kind: 'none', approver: lead, why: 'this tab is not bound to a session of the team, so the guard cannot tell whose push it is' };
    }
    if (session === lead) {
      return leadClearanceOf(runtime, kit, config);
    }
    const { state } = await new JsonlEventLog(runtime.files, kit.paths.events).read();
    const approvers = tree.chainOf(session);
    const approved = approvedTaskOf(state.tasks.values(), session, approvers);
    return approved === undefined
      ? { kind: 'none', approver: approvers[0] ?? lead, why: approvers.length > 1 ? `neither ${approvers.join(' nor ')} has approved a waiting task of ${session}'s` : `${lead} has approved no waiting task of ${session}'s` }
      : { kind: 'approved', by: approved.by, task: approved.task.id };
  } catch (error) {
    return { kind: 'none', approver: lead, why: `the guard could not read the register (${errorMessage(error)})` };
  }
}

/**
 * The lead's own push: cleared on a root team; on a child team (T1140), only by a waiting task of the lead's that the
 * parent team's lead approved, as `<team>/<id>`. A parent with no config to read clears nothing: whoever approves is
 * unknown. Throws when the tree or register cannot be read; the caller refuses.
 */
async function leadClearanceOf(runtime: CliRuntime, kit: Kit, config: KitConfig): Promise<PushClearance> {
  const lead = config.roles.lead;
  const parent = config.team?.parent;
  if (parent === undefined) {
    return { kind: 'lead', lead };
  }
  const above = await leadAboveOf(runtime, kit.paths.team, config);
  if (above === undefined) {
    return { kind: 'none', approver: `the lead of team ${parent}`, why: `team ${parent}, the parent team, has no config to name its lead` };
  }
  const approver = formatAddress(above);
  const { state } = await new JsonlEventLog(runtime.files, kit.paths.events).read();
  const approved = approvedTaskOf(state.tasks.values(), lead, [approver]);
  return approved === undefined
    ? { kind: 'none', approver, why: `${approver}, the lead of the parent team, has approved no waiting task of ${lead}'s` }
    : { kind: 'approved', by: approved.by, task: approved.task.id };
}

/** The push guard's answer: it asks before a push to a protected branch and refuses a force-push of one. */
export function pushGuardOutputOf(runtime: CliRuntime, guard: GuardLoad, payload: unknown): Promise<string> {
  const { kit, load } = guard;
  return pushGuardOutput(payload, {
    cwd: runtime.cwd,
    home: runtime.userHome,
    repo: runtime.git,
    protectedBranches: protectedBranchesOf(load),
    pushToProtected: pushToProtectedOf(load),
    commits: commitsOf(load),
    commitLog: runtime.commitLog,
    skipHooks: skipHooksOf(load),
    hookAsks: hookAsksOf(load),
    clearance: () => pushClearanceOf(runtime, kit, payload),
    platform: runtime.platform,
  });
}

/**
 * The package guard's answer: it refuses, or asks about, a package runner that would fetch and run a package ad hoc,
 * an install of a version the registry does not vouch for, and a package-manager call that would rewrite node_modules
 * through a link.
 */
export function packageGuardOutputOf(runtime: CliRuntime, guard: GuardLoad, payload: unknown): Promise<string> {
  return packageGuardOutput(payload, {
    ...packageGuardOf(guard.load),
    cwd: runtime.cwd,
    home: runtime.userHome,
    files: runtime.files,
    tree: runtime.worktrees.files,
    registry: runtime.packageRegistry,
    clock: runtime.clock,
    hookAsks: hookAsksOf(guard.load),
    platform: runtime.platform,
  });
}

/** The secret guard's answer: it refuses, or asks about, a call that would print a secret or whose text holds one. */
export function secretGuardOutputOf(runtime: CliRuntime, guard: GuardLoad, payload: unknown): string {
  const config = secretGuardOf(guard.load);
  return secretGuardOutput(payload, {
    cwd: runtime.cwd,
    rules: secretRulesOf(config, runtime.userHome, runtime.platform, secretPatternsOf(guard.load)),
    secretReads: config.secretReads,
    writes: config.writes,
    hookAsks: hookAsksOf(guard.load),
  });
}

/**
 * Who this tab runs as, for the exec guard: its team session and the roster to read a `--session` word with. It never
 * throws: a config or roster it cannot read leaves the tab unbound, so every review from it is refused, saying why.
 */
async function tabIdentityOf(runtime: CliRuntime, kit: Kit | undefined, payload: unknown): Promise<TabIdentity> {
  if (kit === undefined || kit.load.status !== 'loaded') {
    return { kind: 'unbound', why: 'the team config did not load' };
  }
  const { config } = kit.load;
  try {
    const roster = await rosterOf(runtime, kit, config);
    const session = await teamSessionOf(runtime, kit, roster, sessionIdOf(payload));
    if (session === undefined) {
      return { kind: 'unbound', why: 'this tab is not bound to a session of the team' };
    }
    const idOf = (name: string): string | undefined => {
      const found = roster.lookup(name);
      return found.ok ? found.id : undefined;
    };
    return { kind: 'bound', session, owner: config.register.ownerSource, idOf };
  } catch (error) {
    return { kind: 'unbound', why: `the guard could not read the roster (${errorMessage(error)})` };
  }
}

/**
 * The exec guard's answer: it refuses a `teamrig exec` review run as anyone but the tab's own session, and any
 * `teamrig exec` call through a client that is no install of this plugin, or one whose files differ from its build.
 */
export function execGuardOutputOf(runtime: CliRuntime, guard: GuardLoad, payload: unknown): Promise<string> {
  return execGuardOutput(payload, {
    cwd: runtime.cwd,
    home: runtime.userHome,
    hookAsks: hookAsksOf(guard.load),
    identity: () => tabIdentityOf(runtime, guard.kit, payload),
    installs: new ClientInstalls(clientRootOf(runtime.self.script), runtime.platform),
    search: new ShellPathSearch({ env: runtime.env, platform: runtime.platform, probe: runtime.probe }),
    checkClient: (root) => checkClient(root, runtime.files),
    platform: runtime.platform,
  });
}
