import type { JsonRecord } from '../core/guards.ts';
import { parseJsonl } from '../core/jsonl.ts';
import { isCappedCommand } from '../permissions/service-commands.ts';
import type { RoleCall } from '../permissions/service-role-call.ts';
import { holdBackOutput } from './permission.ts';

/**
 * The service-role allow (T2984, the owner's option A): a session holding a role runs the role's teamrig commands with no
 * permission check, so a job the owner gave it (closing the GitHub issue a fix landed for, shipping its own branch)
 * never stalls on a prompt. It answers only for the tab bound to the holder (C1), only once every guard passed the
 * call, and only up to `prompts.serviceRoleDailyCap` closes, comments and migrate runs a role in 24 hours, then it asks
 * the owner (C6); a ship is held to the holder's own task branch instead (C4). Its log line names the role, command
 * and issue or branch, never the text (C7); `prompts.routeAllow: off` takes it away.
 */

/** A role call's command and what it acts on, as the log and the allow name them. */
export type RoleTarget = Pick<RoleCall, 'command' | 'target'>;

/** The rolling window the daily cap counts over. */
export const ROLE_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How many closes, comments and migrates the role's allow let run at or after `sinceMs`, by the prompt-answers log's text; a ship counts toward no cap. */
export function roleAllowsSince(log: string, role: string, sinceMs: number): number {
  return parseJsonl(log).records.filter(({ record }) => {
    const at = record['at'];
    return record['answer'] === 'role' && record['role'] === role && isCappedCommand(record['command']) && typeof at === 'string' && Date.parse(at) >= sinceMs;
  }).length;
}

/** Who ran a role's call, and when. */
export interface RoleAllowFacts {
  readonly at: Date;
  readonly session: string;
  readonly claudeSession: string;
  readonly role: string;
  /** The command, and what it acts on: the issue, or the branch a ship or merge runs on. */
  readonly call: RoleTarget;
}

/**
 * One line of the team's prompt-answers log for a role's allow, beside the route allows: the role, the table command and
 * the issue or branch it acts on, never the comment's text (C7).
 */
export function roleAllowRecord(facts: RoleAllowFacts): JsonRecord {
  return {
    v: 1,
    at: facts.at.toISOString(),
    session: facts.session,
    claudeSession: facts.claudeSession,
    tool: 'Bash',
    event: 'PreToolUse',
    answer: 'role',
    role: facts.role,
    command: facts.call.command,
    target: facts.call.target,
  };
}

/** The hook's stdout for a role's call: an allow naming the role, the command and the issue or branch. */
export function roleAllowOutput(role: string, call: RoleTarget): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `teamrig: the service role ${role} lets this session run ${call.command} on ${call.target}`,
    },
  });
}

/** The hook's stdout once the role ran its cap in 24 hours: a refusal, saying when the role runs again. */
export function roleCapOutput(role: string, cap: number): string {
  return holdBackOutput(
    'ask',
    `teamrig: the service role ${role} ran its ${cap} calls of the last 24 hours (prompts.serviceRoleDailyCap), so this ` +
      'one is refused. The role runs again once its oldest call of the window is 24 hours old; only the owner raises the cap.',
  );
}
