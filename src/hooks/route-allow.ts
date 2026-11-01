import type { PromptsConfig } from '../config/types.ts';
import type { JsonRecord } from '../core/guards.ts';
import type { RouteId, SanctionedRoute } from '../permissions/sanctioned.ts';

/**
 * The PreToolUse route allow (T679, design M1, security rulings Q7.1-Q7.5): a Bash line that runs a sanctioned route
 * marked `preToolUse` runs before any permission check, so the auto-mode classifier never turns a session's own job
 * into a dead end. The allow comes from one decision point, after every teamrig guard passed the same call (Q7.1); it
 * covers only the routes the owner granted already or that stay local (Q7.3); its log line names the route alone, never
 * the line (Q7.4); and `prompts.routeAllow: off` takes it away without a release (Q7.5).
 */

/** Whether the allow answers at all: only while the team refuses asks, and only with its off-switch on (Q7.5). */
export function routeAllowOn(prompts: PromptsConfig): boolean {
  return prompts.hookAsks === 'refuse' && prompts.routeAllow === 'on';
}

/** The route a PreToolUse allow may run: one marked for it (Q7.3); undefined for any other route or none. */
export function preToolUseRouteOf(route: SanctionedRoute | undefined): SanctionedRoute | undefined {
  return route?.preToolUse === true ? route : undefined;
}

/**
 * True when every guard let the call go: each answer is a guard hook's output, '' when it passes. A guard that asks or
 * refuses answers the call through its own hook, and the allow stays out of its way (Q7.1).
 */
export function guardsPassed(answers: readonly string[]): boolean {
  return answers.every((answer) => answer === '');
}

/** The hook's stdout: an allow that runs the route's line with no permission check, naming the route. */
export function routeAllowOutput(route: SanctionedRoute): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `teamrig: the sanctioned route ${route.id}, to ${route.purpose}`,
    },
  });
}

/** Who ran the allowed route, and when: the team session and the Claude Code session, when known. */
export interface RouteAllowFacts {
  readonly at: Date;
  readonly session: string | undefined;
  readonly claudeSession: string | null;
  readonly route: RouteId;
}

/**
 * One line of the team's prompt-answers log for an allowed route, beside the PermissionRequest answers: the same fields,
 * marked as a PreToolUse answer, with no command (a commit message is free text, Q7.4).
 */
export function routeAllowRecord(facts: RouteAllowFacts): JsonRecord {
  return {
    v: 1,
    at: facts.at.toISOString(),
    session: facts.session ?? null,
    claudeSession: facts.claudeSession,
    tool: 'Bash',
    event: 'PreToolUse',
    answer: 'route',
    route: facts.route,
    command: null,
  };
}
