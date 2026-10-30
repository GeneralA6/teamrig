import type { HookAsks } from '../config/types.ts';
import { recordField, stringField, type JsonRecord } from '../core/guards.ts';
import type { SecretScanner } from '../core/secrets.ts';
import { redact } from '../exec/redact.ts';
import type { RouteId } from '../permissions/sanctioned.ts';
import { ASK_REFUSED_NOTE } from './permission.ts';
import { rerunForm } from './rerun-forms.ts';

/**
 * The prompt refusal: under `prompts.hookAsks: refuse`, answers each permission prompt Claude Code is about to raise on
 * its own (a call its permission rules do not allow in a mode that asks, a safety check that always asks), so no session
 * waits for hours on a prompt nobody answers. Each call gets the answer for its case: a Bash line that runs a
 * sanctioned route, or provably only reads, runs; a line teamrig's rules give a rerun form is refused quoting that
 * form; anything else is refused with what to do instead. The question picker and plan mode's exit are questions to
 * the person, not permissions: the picker guard and the person decide those, so they open.
 */

/** Tools whose prompt is a question to the person, not a permission: this hook leaves them to open. */
const QUESTION_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** How many characters of a call's command a logged answer keeps. */
export const LOGGED_COMMAND_CHARS = 200;

/** The tool whose prompt the hook answers: asks are off and it is a PermissionRequest of a tool that is no question; else undefined. */
export function refusedTool(asks: HookAsks, payload: JsonRecord): string | undefined {
  const tool = stringField(payload, 'tool_name');
  const refuses = asks === 'refuse' && stringField(payload, 'hook_event_name') === 'PermissionRequest' && tool !== undefined && !QUESTION_TOOLS.has(tool);
  return refuses ? tool : undefined;
}

/** The hook's answer to a prompt: it runs as a sanctioned route or as read-only, it is refused with a form to rerun, or it is refused. */
export type PromptAnswer =
  | { readonly kind: 'route'; readonly route: RouteId }
  | { readonly kind: 'readonly' }
  | { readonly kind: 'rerun'; readonly form: string }
  | { readonly kind: 'refused' };

/**
 * The answer for the prompt of a `tool` call: a line the caller found runs a sanctioned route (`route`,
 * permissions/sanctioned.ts) runs first; a line `reads` proves only reads and prints no secret runs, as the read-only
 * allow would have let it; a line with a rerun form (hooks/rerun-forms.ts) is refused quoting it; anything else is
 * refused.
 */
export function promptAnswerOf(tool: string, payload: JsonRecord, reads: (call: JsonRecord) => boolean, route: RouteId | undefined): PromptAnswer {
  if (route !== undefined) {
    return { kind: 'route', route };
  }
  if (reads(payload)) {
    return { kind: 'readonly' };
  }
  const command = commandOf(payload);
  const form = command === undefined ? undefined : rerunForm(tool, command);
  return form === undefined ? { kind: 'refused' } : { kind: 'rerun', form };
}

/** Why the prompt for a `tool` call is refused, and what to do instead. */
export function promptRefusedReason(tool: string): string {
  return `Claude Code would ask a person to allow this ${tool} call. ${ASK_REFUSED_NOTE}`;
}

/** Why the prompt for a `tool` call is refused, quoting the line to run instead. */
export function rerunReason(tool: string, form: string): string {
  return `Claude Code would ask a person to allow this ${tool} call, and teamrig's rules give it a form that needs no prompt. Do not retry this line; rerun it as: ${form}`;
}

/** The hook's stdout for a refusal: a PermissionRequest deny whose message Claude reads; the turn goes on. */
export function promptRefuseOutput(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: reason } } });
}

/** The hook's stdout for an answer: an allow for a route or a read-only line, which runs it with no prompt, else its refusal. */
export function promptAnswerOutput(tool: string, answer: PromptAnswer): string {
  switch (answer.kind) {
    case 'route':
    case 'readonly':
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    case 'rerun':
      return promptRefuseOutput(rerunReason(tool, answer.form));
    case 'refused':
      return promptRefuseOutput(promptRefusedReason(tool));
  }
}

/** Who answered and what: the team session and the Claude Code session, when known. */
export interface PromptAnswerFacts {
  readonly at: Date;
  readonly session: string | undefined;
  readonly claudeSession: string | null;
  readonly tool: string;
  readonly answer: PromptAnswer;
  readonly payload: JsonRecord;
}

/**
 * One line of the team's prompt-answers log, for the daily triage that turns each refused line into a fixed guard or a
 * new rerun form. The command is redacted (a URL's user part and the scanner's secret shapes), then cut to its first
 * `LOGGED_COMMAND_CHARS` characters: redacting first leaves no secret whose start the cut would keep. A route's line
 * keeps only its route, never its command: a commit message is free text (security ruling Q7.4). The rest of the
 * input is never kept.
 */
export function promptAnswerRecord(facts: PromptAnswerFacts, scanner: SecretScanner): JsonRecord {
  const { answer } = facts;
  const command = answer.kind === 'route' ? undefined : commandOf(facts.payload);
  return {
    v: 1,
    at: facts.at.toISOString(),
    session: facts.session ?? null,
    claudeSession: facts.claudeSession,
    tool: facts.tool,
    answer: answer.kind,
    ...(answer.kind === 'route' ? { route: answer.route } : {}),
    command: command === undefined ? null : redact(command, [], scanner).slice(0, LOGGED_COMMAND_CHARS),
  };
}

function commandOf(payload: JsonRecord): string | undefined {
  return stringField(recordField(payload, 'tool_input') ?? {}, 'command');
}
