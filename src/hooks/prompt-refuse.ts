import type { HookAsks } from '../config/types.ts';
import { stringField, type JsonRecord } from '../core/guards.ts';
import { ASK_REFUSED_NOTE } from './permission.ts';

/**
 * The prompt refusal: under `prompts.hookAsks: refuse`, answers each permission prompt Claude Code is about to raise on
 * its own (a call its permission rules do not allow in a mode that asks, a safety check that always asks) with a refusal
 * that says what to do instead, so no session waits for hours on a prompt nobody answers. The question picker and plan
 * mode's exit are questions to the person, not permissions: the picker guard and the person decide those, so they open.
 */

/** Tools whose prompt is a question to the person, not a permission: this hook leaves them to open. */
const QUESTION_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** The tool whose prompt the hook refuses: asks are off and it is a PermissionRequest of a tool that is no question; else undefined. */
export function refusedTool(asks: HookAsks, payload: JsonRecord): string | undefined {
  const tool = stringField(payload, 'tool_name');
  const refuses = asks === 'refuse' && stringField(payload, 'hook_event_name') === 'PermissionRequest' && tool !== undefined && !QUESTION_TOOLS.has(tool);
  return refuses ? tool : undefined;
}

/** Why the prompt for a `tool` call is refused, and what to do instead. */
export function promptRefusedReason(tool: string): string {
  return `Claude Code would ask a person to allow this ${tool} call. ${ASK_REFUSED_NOTE}`;
}

/** The hook's stdout for a refusal: a PermissionRequest deny whose message Claude reads; the turn goes on. */
export function promptRefuseOutput(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: reason } } });
}
