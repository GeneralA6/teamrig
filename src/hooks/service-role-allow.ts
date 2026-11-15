import type { HookAsks, ServiceRoleConfig } from '../config/types.ts';
import type { JsonRecord } from '../core/guards.ts';
import { parseJsonl } from '../core/jsonl.ts';
import { TEAM_HELD_COMMANDS, type ServiceCommand } from '../permissions/service-commands.ts';
import type { RoleCall } from '../permissions/service-role-call.ts';
import { holdBackOutput } from './permission.ts';

/**
 * The service-role allow (T2984, the owner's option A): a session holding a role runs the role's teamrig commands with no
 * permission check, so a job the owner gave it (closing the GitHub issue a fix landed for) never stalls on a prompt.
 * It answers only for the tab bound to the holder (C1), only once every guard passed the call, and only up to
 * `prompts.serviceRoleDailyCap` calls a role in 24 hours, then it asks the owner (C6). Its log line names the role,
 * command and issue, never the text (C7); `prompts.routeAllow: off` takes it away.
 */

/** The rolling window the daily cap counts over. */
export const ROLE_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** True when the role gives `command` to `holder`: a holder it names, or every session for a command that checks its own caller. */
function holds(role: ServiceRoleConfig, command: ServiceCommand, holder: string): boolean {
  if (!role.commands.includes(command)) {
    return false;
  }
  return role.holders === 'team' ? TEAM_HELD_COMMANDS.has(command) : role.holders.includes(holder);
}

/** The role, by name, that gives `holder` the command; the first by name when two do, so the cap counts one; else undefined. */
export function roleHolding(roles: Readonly<Record<string, ServiceRoleConfig>>, command: ServiceCommand, holder: string): string | undefined {
  return Object.keys(roles)
    .sort()
    .find((name) => {
      const role = roles[name];
      return role !== undefined && holds(role, command, holder);
    });
}

/** How many calls the role's allow let run at or after `sinceMs`, by the prompt-answers log's text. */
export function roleAllowsSince(log: string, role: string, sinceMs: number): number {
  return parseJsonl(log).records.filter(({ record }) => {
    const at = record['at'];
    return record['answer'] === 'role' && record['role'] === role && typeof at === 'string' && Date.parse(at) >= sinceMs;
  }).length;
}

/** Who ran a role's call, and when. */
export interface RoleAllowFacts {
  readonly at: Date;
  readonly session: string;
  readonly claudeSession: string;
  readonly role: string;
  readonly call: RoleCall;
}

/**
 * One line of the team's prompt-answers log for a role's allow, beside the route allows: the role, the table command and
 * the issue it acts on, never the comment's text (C7).
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

/** The hook's stdout for a role's call: an allow naming the role, the command and the issue. */
export function roleAllowOutput(role: string, call: RoleCall): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `teamrig: the service role ${role} lets this session run ${call.command} on ${call.target}`,
    },
  });
}

/** The hook's stdout once the role ran its cap in 24 hours: an ask of the owner, a refusal when asks are off. */
export function roleCapOutput(role: string, cap: number, asks: HookAsks): string {
  return holdBackOutput(
    'ask',
    `teamrig: the service role ${role} ran its ${cap} calls of the last 24 hours (prompts.serviceRoleDailyCap), so this ` +
      'one asks the owner. Owner: allow it only if this many calls of the role are what you expect; a session does not ' +
      'retry it or route around it, it tells its lead.',
    asks,
  );
}
