import { DEFAULT_COMMITS, DEFAULT_PUSH_GUARD } from '../config/defaults.ts';
import type { ConfigLoad } from '../config/load.ts';
import type { CommitsConfig } from '../config/types.ts';
import { isRecord, recordField, stringField } from '../core/guards.ts';
import { describeLargeCommits, largeCommits, type CommitLog, type CommitStat, type LargeCommit } from '../push-guard/commit-size.ts';
import { decisionReason, evaluatePushes, type ProtectedUpdate, type RepoState } from '../push-guard/push.ts';

export interface PushGuardEnv {
  /** The folder to judge from when the payload names none. */
  readonly cwd: string;
  readonly home: string;
  readonly repo: RepoState;
  readonly protectedBranches: readonly string[];
  /** The small-commits rule; its gate decides whether an asked push lists or refuses large commits. */
  readonly commits: CommitsConfig;
  readonly commitLog: CommitLog;
}

/**
 * The branches to guard. A missing or unreadable config keeps the defaults, so a broken
 * config never switches the guard off; a loaded one has already replaced each bad field
 * with its default.
 */
export function protectedBranchesOf(load: ConfigLoad | undefined): readonly string[] {
  return load?.status === 'loaded' ? load.config.pushGuard.protectedBranches : DEFAULT_PUSH_GUARD.protectedBranches;
}

/** The small-commits rule, with the same fallback as the protected branches. */
export function commitsOf(load: ConfigLoad | undefined): CommitsConfig {
  return load?.status === 'loaded' ? load.config.commits : DEFAULT_COMMITS;
}

/** The large commits the updates would send, each once. A range git cannot list adds none, so a broken log never blocks a push. */
function largeCommitsIn(updates: readonly ProtectedUpdate[], env: PushGuardEnv): LargeCommit[] {
  if (env.commits.gate === 'off') {
    return [];
  }
  const commits = new Map<string, CommitStat>();
  for (const update of updates) {
    for (const commit of env.commitLog.between(update.dir, update.base, update.source) ?? []) {
      commits.set(commit.sha, commit);
    }
  }
  return largeCommits([...commits.values()], env.commits);
}

/**
 * The PreToolUse hook's stdout for one Bash or PowerShell call: a permission decision when the
 * command pushes to a protected branch, else nothing, so the normal permission flow decides.
 * Under the commits gate, an asked push also lists the large commits it sends (`warn`) or is
 * refused for them (`refuse`).
 */
export function pushGuardOutput(payload: unknown, env: PushGuardEnv): string {
  if (!isRecord(payload)) {
    return '';
  }
  const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
  if (command === undefined) {
    return '';
  }
  const verdict = evaluatePushes(command, {
    cwd: stringField(payload, 'cwd') ?? env.cwd,
    home: env.home,
    dialect: stringField(payload, 'tool_name') === 'PowerShell' ? 'powershell' : 'bash',
    protectedBranches: env.protectedBranches,
    repo: env.repo,
  });
  if (verdict.decision === 'allow') {
    return '';
  }
  const large = verdict.decision === 'ask' ? largeCommitsIn(verdict.updates, env) : [];
  const refused = large.length > 0 && env.commits.gate === 'refuse';
  const reason =
    large.length === 0
      ? decisionReason(verdict.decision, env.protectedBranches)
      : refused
        ? `This push to a protected branch (${env.protectedBranches.join(', ')}) is refused: ${describeLargeCommits(large, env.commits)}`
        : `${decisionReason('ask', env.protectedBranches)} ${describeLargeCommits(large, env.commits)}`;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: refused ? 'deny' : verdict.decision,
      permissionDecisionReason: reason,
    },
  });
}
