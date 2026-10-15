import { DEFAULT_COMMITS, DEFAULT_PUSH_GUARD } from '../config/defaults.ts';
import type { ConfigLoad } from '../config/load.ts';
import type { CommitsConfig, PushToProtected } from '../config/types.ts';
import { isRecord, recordField, stringField } from '../core/guards.ts';
import { describeLargeCommits, largeCommits, type CommitLog, type CommitStat, type LargeCommit } from '../push-guard/commit-size.ts';
import {
  decisionReason,
  doubtReason,
  evaluatePushes,
  leasedReason,
  type ProtectedUpdate,
  type PushDecision,
  type PushVerdict,
  type RepoState,
} from '../push-guard/push.ts';

export interface PushGuardEnv {
  /** The folder to judge from when the payload names none. */
  readonly cwd: string;
  readonly home: string;
  readonly repo: RepoState;
  readonly protectedBranches: readonly string[];
  /** What a normal push to a protected branch gets: a question, or a note while it goes through. */
  readonly pushToProtected: PushToProtected;
  /** The small-commits rule; its gate decides whether an asked or allowed push lists or refuses large commits. */
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

/** What a normal push to a protected branch gets, with the same fallback as the protected branches: a broken config asks. */
export function pushToProtectedOf(load: ConfigLoad | undefined): PushToProtected {
  return load?.status === 'loaded' ? load.config.pushGuard.pushToProtected : DEFAULT_PUSH_GUARD.pushToProtected;
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

/** Ends the question about a normal push to a protected branch, naming the switch that stops it. */
export const PUSH_TO_PROTECTED_HINT = "To stop asking about normal pushes, set pushGuard.pushToProtected to allow in the team's config.json.";

/** The note shown when `pushToProtected: allow` lets a normal push to a protected branch through. */
export function allowedPushNote(protectedBranches: readonly string[]): string {
  return `teamrig did not ask about this push to a protected branch (${protectedBranches.join(', ')}): pushGuard.pushToProtected is allow.`;
}

/**
 * Why the guard stops the line. Only the question about a normal push names the switch: a leased push and a line the
 * guard cannot read still ask under `allow`, since either may rewrite or delete the branch.
 */
function stopReason(verdict: PushVerdict, decision: Exclude<PushDecision, 'allow'>, protectedBranches: readonly string[]): string {
  if (verdict.doubt !== undefined) {
    return doubtReason(verdict.doubt, protectedBranches);
  }
  return verdict.protectedPush === 'leased' ? leasedReason(protectedBranches) : decisionReason(decision, protectedBranches);
}

function permission(decision: Exclude<PushDecision, 'allow'>, reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } });
}

/**
 * The PreToolUse hook's stdout for one Bash or PowerShell call: a permission decision when the
 * command pushes to a protected branch, else nothing, so the normal permission flow decides.
 * Under `pushToProtected: allow` a normal push to a protected branch gets a note (`systemMessage`)
 * instead of a question, and the normal permission flow still decides. Under the commits gate, an
 * asked or allowed push also lists the large commits it sends (`warn`) or is refused for them
 * (`refuse`). A command the guard cannot read with confidence is asked about, with a reason that
 * says what it could not read.
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
    pushToProtected: env.pushToProtected,
    repo: env.repo,
  });
  if (verdict.decision === 'allow' && verdict.protectedPush === undefined) {
    return '';
  }
  const large = verdict.decision === 'deny' ? [] : largeCommitsIn(verdict.updates, env);
  const listing = large.length === 0 ? '' : ` ${describeLargeCommits(large, env.commits)}`;
  if (large.length > 0 && env.commits.gate === 'refuse') {
    return permission('deny', `This push to a protected branch (${env.protectedBranches.join(', ')}) is refused: ${describeLargeCommits(large, env.commits)}`);
  }
  if (verdict.decision === 'allow') {
    return JSON.stringify({ systemMessage: `${allowedPushNote(env.protectedBranches)}${listing}` });
  }
  const hint = verdict.decision === 'ask' && verdict.protectedPush === 'normal' ? ` ${PUSH_TO_PROTECTED_HINT}` : '';
  return permission(verdict.decision, `${stopReason(verdict, verdict.decision, env.protectedBranches)}${listing}${hint}`);
}
