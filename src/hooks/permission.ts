import { DEFAULT_PROMPTS } from '../config/defaults.ts';
import type { ConfigLoad } from '../config/load.ts';
import type { HookAsks } from '../config/types.ts';
import type { HookReply } from '../ports/host/index.ts';

/** How a teamrig hook holds a call back: one it would once have asked a person about, or a plain refusal. */
export type HoldBack = 'ask' | 'deny';

/**
 * What the session does with a call a guard holds back instead of asking a person (T3356): take the route the reason
 * names, record a step that still needs a person's yes for the owner, and ask for a rule change it thinks is wrong.
 */
export const ASK_REFUSED_NOTE =
  'teamrig guards never ask a person, so this is refused; do not retry it or route around it. Take the route the reason ' +
  'names; if the step still needs a person\'s yes, record it as waiting for the owner (`teamrig set <task> --status ' +
  'waiting --waits approval:owner --note "<the command>"`) and take your next task. If you think the rule is wrong, ask ' +
  'for a change as a task: `teamrig add --owner <your lead> --title "Rule change: <guard>: <why>"`, or to the security ' +
  'reviewer for a security rule.';

/**
 * Whether Claude Code's own permission prompts are refused too (hooks/prompt-refuse.ts). A missing or unreadable
 * config keeps the default. teamrig's guards never ask, whatever it says.
 */
export function hookAsksOf(load: ConfigLoad | undefined): HookAsks {
  return load?.status === 'loaded' ? load.config.prompts.hookAsks : DEFAULT_PROMPTS.hookAsks;
}

/** A hook's reply refusing a call with its reason as given. */
export function refusal(reason: string): HookReply {
  return { verdict: { kind: 'deny', reason } };
}

/**
 * A hook's reply holding a call back. A guard never asks a person: a prompt holds the session's tab until someone
 * answers it (T3356). What it would have asked about is refused instead, its reason followed by what to do
 * (`ASK_REFUSED_NOTE`); a refusal stays a refusal with its own reason.
 */
export function heldBack(decision: HoldBack, reason: string): HookReply {
  return refusal(decision === 'ask' ? `${reason} ${ASK_REFUSED_NOTE}` : reason);
}
