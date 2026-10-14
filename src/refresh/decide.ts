import type { RefreshConfig } from '../config/types.ts';
import { lineHash } from '../inbox/marks.ts';
import type { RefreshState } from './state.ts';

/**
 * The context-refresh rules, as pure functions of the session's state, what was measured, the
 * team's settings and the time: the hooks and commands only read and write what these decide.
 */

export type RefreshSettings = Pick<RefreshConfig, 'enabled' | 'contextTokens' | 'tabTitle'>;

/** What the Stop hook knows before it reads anything but the session's state file. */
export interface StopContext {
  /** Claude Code's `stop_hook_active`: this stop ends a turn a Stop hook already continued. */
  readonly stopHookActive: boolean;
  readonly settings: RefreshSettings;
  readonly now: string;
  readonly session: { readonly id: string; readonly name: string };
  readonly handoverPath: string;
  /** The CLI's name, as the session runs it from its Bash tool. */
  readonly command: string;
}

/** What the Stop hook reads only at a boundary it has not judged yet. */
export interface BoundaryFacts {
  /** The name of the lead that asked for a refresh; undefined when nobody asked. */
  readonly requestedBy: string | undefined;
  /** The context size; undefined when the transcript does not tell, which never asks for a refresh. */
  readonly tokens: number | undefined;
  /** The fingerprint of the handover file as it is now; null when there is none. */
  readonly handoverHash: string | null;
}

export type StopDecision =
  | { readonly kind: 'none' }
  /** A boundary to judge: read its facts and decide again with them. */
  | { readonly kind: 'measure' }
  /** Judged, no refresh due: record it, say nothing. */
  | { readonly kind: 'write'; readonly state: RefreshState }
  /** Keep the session going with `reason` as its next instruction: write the handover. */
  | { readonly kind: 'block'; readonly state: RefreshState; readonly reason: string }
  /** Tell the user the session waits for /clear; `title` marks the tab when the team wants it. */
  | { readonly kind: 'notice'; readonly state: RefreshState; readonly message: string; readonly title: string | undefined };

const NONE: StopDecision = { kind: 'none' };
const MEASURE: StopDecision = { kind: 'measure' };

/** Tokens as people say them: 262,144 is `262k`. */
export function thousands(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

/** The command that tells the kit the handover is written; `--session` so it works without `$TEAMRIG_SESSION`. */
export function readyCommand(command: string, session: string): string {
  return `${command} refresh --ready --session ${session}`;
}

/** Why a boundary refreshes: the lead asked, or the context reached the threshold. */
type Cause = { readonly kind: 'asked'; readonly by: string; readonly tokens: number | null } | { readonly kind: 'size'; readonly tokens: number };

function causeOf(facts: BoundaryFacts, threshold: number): Cause | undefined {
  if (facts.requestedBy !== undefined) {
    return { kind: 'asked', by: facts.requestedBy, tokens: facts.tokens ?? null };
  }
  return facts.tokens !== undefined && facts.tokens >= threshold ? { kind: 'size', tokens: facts.tokens } : undefined;
}

function handoverAsk(task: string, cause: Cause, context: StopContext): string {
  const why =
    cause.kind === 'size'
      ? `your context is ${thousands(cause.tokens)} (refresh at ${thousands(context.settings.contextTokens)})`
      : `${cause.by} asked for a refresh${cause.tokens === null ? '' : ` (your context is ${thousands(cause.tokens)})`}`;
  return (
    `${context.command}: ${why} and you just finished ${task}. Write your handover to ${context.handoverPath} ` +
    '(what is in progress, the next step of each, open questions, where things are), then run ' +
    `\`${readyCommand(context.command, context.session.id)}\`. Do not start new work.`
  );
}

/**
 * The Stop hook, at the end of every turn. Only a boundary (a task just finished) is judged, once:
 * at or over the threshold, or when the lead asked, the session is kept going to write its handover;
 * otherwise the boundary is recorded as judged and nothing is said. A stop that ends a turn a Stop
 * hook continued never judges a boundary, so the kit never loops; the notice that the handover is
 * written does show there, since that is the turn that runs `refresh --ready`.
 */
export function decideStop(state: RefreshState | undefined, context: StopContext, facts?: BoundaryFacts): StopDecision {
  if (state === undefined || !context.settings.enabled) {
    return NONE;
  }
  if (state.phase === 'ready') {
    const { name } = context.session;
    return state.noticed
      ? NONE
      : {
          kind: 'notice',
          state: { ...state, noticed: true },
          message: `${context.command}: ${name} finished ${state.task} and wrote its handover; type /clear for a fresh start`,
          title: context.settings.tabTitle ? `↻ ${name}` : undefined,
        };
  }
  if (state.phase !== 'boundary' || context.stopHookActive) {
    return NONE;
  }
  if (facts === undefined) {
    return MEASURE;
  }
  const tokens = facts.tokens ?? null;
  const cause = causeOf(facts, context.settings.contextTokens);
  if (cause === undefined) {
    return { kind: 'write', state: { phase: 'idle', task: state.task, at: context.now, tokens } };
  }
  return {
    kind: 'block',
    state: { phase: 'asked', task: state.task, at: context.now, tokens, handoverHash: facts.handoverHash },
    reason: handoverAsk(state.task, cause, context),
  };
}

/** The fingerprint `decideStop` and `decideReady` compare; null for no handover. */
export function handoverHashOf(text: string | undefined): string | null {
  return text === undefined ? null : lineHash(text);
}

export type ReadyDecision =
  | { readonly kind: 'refused'; readonly reason: string }
  /** Already ready: nothing to write, the same answer again. */
  | { readonly kind: 'already' }
  | { readonly kind: 'ready'; readonly state: RefreshState };

/**
 * `refresh --ready`: only after the Stop hook asked for a handover, and only once the handover
 * exists, is not blank and differs from the file that was there when it asked (the files port has
 * no modification times, so the fingerprint stands for "written since").
 */
export function decideReady(state: RefreshState | undefined, handover: string | undefined, handoverPath: string, now: string): ReadyDecision {
  if (state?.phase === 'ready') {
    return { kind: 'already' };
  }
  if (state?.phase !== 'asked') {
    return {
      kind: 'refused',
      reason: 'no refresh was asked of you: one is asked when you finish a task with your context over the threshold, or after the lead asked for it',
    };
  }
  if (handover === undefined || handover.trim() === '') {
    return { kind: 'refused', reason: `write your handover to ${handoverPath} first` };
  }
  if (handoverHashOf(handover) === state.handoverHash) {
    return { kind: 'refused', reason: `${handoverPath} is the handover from before; write this refresh's handover there` };
  }
  return { kind: 'ready', state: { phase: 'ready', task: state.task, at: now, noticed: false } };
}

/** Starts that drop the old context; a `compact`, `resume` or `fork` start keeps it, so the handover waits. */
const FRESH_SOURCES: ReadonlySet<string> = new Set(['clear', 'startup']);

export type StartDecision = { readonly kind: 'none' } | { readonly kind: 'inject'; readonly note: string; readonly state: RefreshState };

/** SessionStart: the first fresh start after the handover was written points the session at it, once. */
export function decideStart(
  state: RefreshState | undefined,
  source: string | undefined,
  settings: Pick<RefreshSettings, 'enabled'>,
  handoverPath: string,
  now: string,
): StartDecision {
  if (!settings.enabled || state?.phase !== 'ready' || source === undefined || !FRESH_SOURCES.has(source)) {
    return { kind: 'none' };
  }
  return {
    kind: 'inject',
    note: `You were refreshed after ${state.task}; read your handover first: ${handoverPath}`,
    state: { phase: 'refreshed', task: state.task, at: now },
  };
}
