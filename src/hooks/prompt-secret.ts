import { KIT_NAME } from '../core/home.ts';
import type { PromptSecret } from '../secret-guard/prompt-secrets.ts';

/**
 * The prompt secret block (T1481): a prompt that holds a secret is stopped before Claude reads it and kept out of the
 * transcript, and the reason shown to the person names only the secret's shape, says what to send instead, and tells
 * what the history clean removed.
 */

/** What the history clean did at the block. */
export type HistoryOutcome =
  /** Cleaned: `lines` of Claude Code's prompt history and `pastes` pasted texts held the secret and are gone. */
  | { readonly kind: 'cleaned'; readonly lines: number; readonly pastes: number }
  /** The clean failed, and the blocked prompt is pending: the next prompt cleans again. */
  | { readonly kind: 'retry' }
  /** Not even recorded as pending: nothing cleans for it again. */
  | { readonly kind: 'failed' };

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function outcomeNote(outcome: HistoryOutcome): string | undefined {
  switch (outcome.kind) {
    case 'cleaned':
      return outcome.lines + outcome.pastes === 0
        ? undefined
        : `Removed from Claude Code's prompt history: ${counted(outcome.lines, 'line')} and ${counted(outcome.pastes, 'pasted text')} that held it.`;
    case 'retry':
      return "Cleaning it out of Claude Code's prompt history failed; your next prompt tries again.";
    case 'failed':
      return "Cleaning it out of Claude Code's prompt history failed: an earlier prompt that held it may stay in history.jsonl.";
  }
}

/** Why the prompt was stopped: the shapes `found` names, never a value, what to send instead and the clean's outcome. */
export function promptSecretReason(found: readonly PromptSecret[], outcome: HistoryOutcome): string {
  const shapes = [...new Set(found.map(({ description }) => description))].join(', ');
  const note = outcomeNote(outcome);
  const reason = `${KIT_NAME} stopped this prompt before Claude read it: it looks like it holds a secret (${shapes}). Send its name or the file it is kept in instead; the value counts as leaked: rotate it.`;
  return note === undefined ? reason : `${reason} ${note}`;
}

/** The hook's stdout for a stopped prompt: a UserPromptSubmit block that also keeps the prompt out of the transcript. */
export function promptBlockOutput(reason: string): string {
  return JSON.stringify({ decision: 'block', reason, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true } });
}
