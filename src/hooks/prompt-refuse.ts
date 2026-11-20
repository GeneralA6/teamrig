import type { HookAsks } from '../config/types.ts';
import { stringField, type JsonRecord } from '../core/guards.ts';
import type { SecretScanner } from '../core/secrets.ts';
import type { RouteId } from '../permissions/sanctioned.ts';
import type { HookEvent, HookReply, ToolCall } from '../ports/host/index.ts';
import { maskCommand } from './log-mask.ts';
import { ASK_REFUSED_NOTE, refusal } from './permission.ts';
import { rerunForm } from './rerun-forms.ts';

/**
 * The prompt refusal: under `prompts.hookAsks: refuse`, answers each permission prompt Claude Code is about to raise on
 * its own (a call its permission rules do not allow in a mode that asks, a safety check that always asks), so no session
 * waits for hours on a prompt nobody answers. Each call gets the answer for its case: a Bash line that runs a
 * sanctioned route, or provably only reads, runs; a line teamrig's rules give a rerun form is refused quoting that
 * form; anything else is refused with what to do instead. The question picker and plan mode's exit are questions to
 * the person, not permissions: the picker guard and the person decide those, so they open.
 */

/** How many characters of a call's command a logged answer keeps. */
export const LOGGED_COMMAND_CHARS = 200;

/**
 * The call whose prompt the hook answers: asks are off and the event is the permission prompt of a call that is no
 * question to the person (the `ask` kind, which this hook leaves to open); else undefined.
 */
export function refusedCall(asks: HookAsks, event: HookEvent): ToolCall | undefined {
  const { call } = event;
  const refuses = asks === 'refuse' && event.name === 'permission-prompt' && call !== undefined && call.kind !== 'ask';
  return refuses ? call : undefined;
}

/** The hook's answer to a prompt: it runs as a sanctioned route or as read-only, it is refused with a form to rerun, or it is refused. */
export type PromptAnswer =
  | { readonly kind: 'route'; readonly route: RouteId }
  | { readonly kind: 'readonly' }
  | { readonly kind: 'rerun'; readonly form: string }
  | { readonly kind: 'refused' };

/**
 * The answer for the prompt of `call`: a line the caller found runs a sanctioned route (`route`,
 * permissions/sanctioned.ts) runs first; a line `reads` proves only reads and prints no secret runs, as the read-only
 * allow would have let it; a shell line with a rerun form (hooks/rerun-forms.ts) is refused quoting it; anything else
 * is refused. `reads` is asked only when no route answers.
 */
export function promptAnswerOf(call: ToolCall, reads: () => boolean, route: RouteId | undefined): PromptAnswer {
  if (route !== undefined) {
    return { kind: 'route', route };
  }
  if (reads()) {
    return { kind: 'readonly' };
  }
  const form = call.kind === 'shell' && call.command !== undefined ? rerunForm(call.dialect, call.command) : undefined;
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

/**
 * The hook's reply for an answer to the prompt of a `tool` call: an allow for a route or a read-only line, which runs
 * it with no prompt, else a refusal whose reason the model reads; the turn goes on.
 */
export function promptAnswerReply(tool: string, answer: PromptAnswer): HookReply {
  switch (answer.kind) {
    case 'route':
    case 'readonly':
      return { verdict: { kind: 'allow' } };
    case 'rerun':
      return refusal(rerunReason(tool, answer.form));
    case 'refused':
      return refusal(promptRefusedReason(tool));
  }
}

/** Who answered and what: the team session and the Claude Code session, when known. */
export interface PromptAnswerFacts {
  readonly at: Date;
  readonly session: string | undefined;
  readonly claudeSession: string | null;
  readonly call: ToolCall;
  readonly answer: PromptAnswer;
}

/**
 * One line of the team's prompt-answers log, for the daily triage that turns each refused line into a fixed guard or a
 * new rerun form. The command is masked (`maskCommand`: a secret name's value, a secret flag's, a login's password, a
 * long base64 run, a URL's user part and the scanner's secret shapes), then cut to its first `LOGGED_COMMAND_CHARS`
 * characters: masking first leaves no secret whose start the cut would keep. A route's line
 * keeps only its route, never its command: a commit message is free text (security ruling Q7.4). The rest of the
 * input is never kept.
 */
export function promptAnswerRecord(facts: PromptAnswerFacts, scanner: SecretScanner): JsonRecord {
  const { answer } = facts;
  const command = answer.kind === 'route' ? undefined : commandOf(facts.call);
  return {
    v: 1,
    at: facts.at.toISOString(),
    session: facts.session ?? null,
    claudeSession: facts.claudeSession,
    tool: facts.call.name,
    answer: answer.kind,
    ...(answer.kind === 'route' ? { route: answer.route } : {}),
    command: command === undefined ? null : maskCommand(command, scanner).slice(0, LOGGED_COMMAND_CHARS),
  };
}

/** The command a call carries: a shell call's line, else the `command` its input names, which a tool of no shell kind may hold. */
function commandOf(call: ToolCall): string | undefined {
  return call.kind === 'shell' ? call.command : stringField(call.input, 'command');
}
