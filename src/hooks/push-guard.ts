import { DEFAULT_PUSH_GUARD } from '../config/defaults.ts';
import type { ConfigLoad } from '../config/load.ts';
import { isRecord, recordField, stringField } from '../core/guards.ts';
import { decisionReason, evaluateCommand, type RepoState } from '../push-guard/push.ts';

export interface PushGuardEnv {
  /** The folder to judge from when the payload names none. */
  readonly cwd: string;
  readonly home: string;
  readonly repo: RepoState;
  readonly protectedBranches: readonly string[];
}

/**
 * The branches to guard. A missing or unreadable config keeps the defaults, so a broken
 * config never switches the guard off; a loaded one has already replaced each bad field
 * with its default.
 */
export function protectedBranchesOf(load: ConfigLoad | undefined): readonly string[] {
  return load?.status === 'loaded' ? load.config.pushGuard.protectedBranches : DEFAULT_PUSH_GUARD.protectedBranches;
}

/**
 * The PreToolUse hook's stdout for one Bash or PowerShell call: a permission decision when the
 * command pushes to a protected branch, else nothing, so the normal permission flow decides.
 */
export function pushGuardOutput(payload: unknown, env: PushGuardEnv): string {
  if (!isRecord(payload)) {
    return '';
  }
  const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
  if (command === undefined) {
    return '';
  }
  const decision = evaluateCommand(command, {
    cwd: stringField(payload, 'cwd') ?? env.cwd,
    home: env.home,
    dialect: stringField(payload, 'tool_name') === 'PowerShell' ? 'powershell' : 'bash',
    protectedBranches: env.protectedBranches,
    repo: env.repo,
  });
  if (decision === 'allow') {
    return '';
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: decisionReason(decision, env.protectedBranches),
    },
  });
}
