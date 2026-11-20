import type { JsonRecord } from '../core/guards.ts';
import { parseJsonl } from '../core/jsonl.ts';
import { isCappedCommand } from '../permissions/service-commands.ts';
import type { RoleCall } from '../permissions/service-role-call.ts';
import type { HookReply } from '../ports/host/index.ts';
import { heldBack } from './permission.ts';

/**
 * The service-role allow (T2984, the owner's option A): a session holding a role runs the role's teamrig commands with no
 * permission check, so a job the owner gave it (closing the GitHub issue a fix landed for, shipping its own branch)
 * never stalls on a prompt. It answers only for the tab bound to the holder (C1), only once every guard passed the
 * call, and only up to `prompts.serviceRoleDailyCap` closes and migrated issues a role in 24 hours, then it asks the
 * owner (C6); a ship is held to the holder's own task branch instead (C4). Its log line names the role, command and
 * issue or branch, never the text (C7); `prompts.routeAllow: off` takes it away.
 */

/** A role call's command and what it acts on, as the log and the allow name them. */
export type RoleTarget = Pick<RoleCall, 'command' | 'target'>;

/** The rolling window the daily cap counts over. */
export const ROLE_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many calls the role's allow let run at or after `sinceMs` toward its cap, by the prompt-answers log's text: one
 * for each close, and for a migrate its `count`, the issue rows its file held (T4606), so a run opening fifty issues
 * weighs fifty; a ship counts toward no cap. A line with no positive whole `count` weighs one.
 */
export function roleAllowsSince(log: string, role: string, sinceMs: number): number {
  return parseJsonl(log)
    .records.filter(({ record }) => {
      const at = record['at'];
      return record['answer'] === 'role' && record['role'] === role && isCappedCommand(record['command']) && typeof at === 'string' && Date.parse(at) >= sinceMs;
    })
    .reduce((sum, { record }) => sum + weightOf(record['count']), 0);
}

function weightOf(count: unknown): number {
  return typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? count : 1;
}

/** Who ran a role's call, and when. */
export interface RoleAllowFacts {
  readonly at: Date;
  readonly session: string;
  readonly claudeSession: string;
  readonly role: string;
  /** The command, and what it acts on: the issue, or the branch a ship or merge runs on. */
  readonly call: RoleTarget;
  /** What a migrate weighs toward the cap: the issue rows of its file (T4606); absent for a call acting on one issue. */
  readonly count?: number;
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
    ...(facts.count === undefined ? {} : { count: facts.count }),
  };
}

/** The hook's reply to a role's call: an allow naming the role, the command and the issue or branch. */
export function roleAllowReply(role: string, call: RoleTarget): HookReply {
  return { verdict: { kind: 'allow', reason: `teamrig: the service role ${role} lets this session run ${call.command} on ${call.target}` } };
}

/**
 * The hook's reply once the role has no room left in 24 hours for a call weighing `weight` (a migrate's issue rows): a
 * refusal, saying when the role runs again, and for a migrate that a file past the whole cap must be split.
 */
export function roleCapReply(role: string, cap: number, weight = 1): HookReply {
  const ran = weight > 1 ? `has less room than this run's ${weight} issue rows left of its ${cap} calls` : `ran its ${cap} calls`;
  const split = weight > cap ? ' A rows file holding more issue rows than the cap never runs under the role: split it.' : '';
  return heldBack(
    'ask',
    `teamrig: the service role ${role} ${ran} of the last 24 hours (prompts.serviceRoleDailyCap), so this one is refused. ` +
      `The role runs again once its oldest call of the window is 24 hours old; only the owner raises the cap.${split}`,
  );
}
