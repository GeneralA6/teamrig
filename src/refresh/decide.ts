import type { RefreshConfig } from '../config/types.ts';
import { lineHash } from '../inbox/line-hash.ts';
import type { RefreshState } from './state.ts';

/**
 * The context-refresh rules, as pure functions of the session's state, what was measured, the
 * team's settings and the time: the hooks and commands only read and write what these decide.
 */

export type RefreshSettings = Pick<RefreshConfig, 'enabled' | 'contextTokens' | 'everyTasks' | 'everyTasksMinTokens' | 'tabTitle' | 'restartDelaySeconds'>;

/** A session whose handover is written, waiting for its fresh start. */
export type ReadyState = Extract<RefreshState, { readonly phase: 'ready' }>;

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
  /** The hook can restart the session once its handover is written: `refresh.autoRestart` is on and Claude Code gave what it needs. */
  readonly canRestart: boolean;
}

/** What the Stop hook reads only at a boundary it has not judged yet, or before saying the handover is written. */
export interface BoundaryFacts {
  /** The name of the lead that asked for a refresh; undefined when nobody asked. */
  readonly requestedBy: string | undefined;
  /** The context size; undefined when the transcript does not tell, which never asks for a refresh. */
  readonly tokens: number | undefined;
  /** The fingerprint of the handover file as it is now; null when there is none. */
  readonly handoverHash: string | null;
  /** Background work the session started that has not reported back (subagents, commands, monitors, workflows). */
  readonly running: number;
}

export type StopDecision =
  | { readonly kind: 'none' }
  /** A boundary to judge: read its facts and decide again with them. */
  | { readonly kind: 'measure' }
  /** Judged, no refresh due: record it, say nothing. */
  | { readonly kind: 'write'; readonly state: RefreshState }
  /** Keep the session going with `reason` as its next instruction: write the handover. */
  | { readonly kind: 'block'; readonly state: RefreshState; readonly reason: string }
  /** Tell the user the session restarts by itself once idle (`restart`), or waits for /clear; `title` marks the tab when the team wants it. */
  | { readonly kind: 'notice'; readonly state: ReadyState; readonly message: string; readonly title: string | undefined; readonly restart: boolean };

export type NoticeDecision = Extract<StopDecision, { readonly kind: 'notice' }>;

const NONE: StopDecision = { kind: 'none' };
const MEASURE: StopDecision = { kind: 'measure' };

/** Tokens as people say them: 262,144 is `262k`. */
export function thousands(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

/** The notice that `state`'s handover is written: the restart to come when `restart`, else the /clear to type. */
export function noticeOf(state: ReadyState, context: StopContext, restart: boolean): NoticeDecision {
  const { name } = context.session;
  const next = restart
    ? `${context.command} starts it fresh once it has been idle ${context.settings.restartDelaySeconds} s (type anything to keep this context)`
    : 'type /clear for a fresh start';
  return {
    kind: 'notice',
    state: { ...state, noticed: true },
    message: `${context.command}: ${name} finished ${state.task} and wrote its handover; ${next}`,
    title: context.settings.tabTitle ? `${name}: ${restart ? 'restarting' : 'type /clear'}` : undefined,
    restart,
  };
}

/** The command that tells the kit the handover is written; `--session` so it works without `$TEAMRIG_SESSION`. */
export function readyCommand(command: string, session: string): string {
  return `${command} refresh --ready --session ${session}`;
}

/** The tasks finished since the context was last fresh, before this one: only a boundary or a judged one counts them. */
function finishedSoFar(state: RefreshState | undefined): number {
  return state?.phase === 'boundary' || state?.phase === 'idle' ? state.finished : 0;
}

/** `set <id> --status done`: the boundary the Stop hook judges, counting this task. */
export function boundaryOf(previous: RefreshState | undefined, task: string, at: string): RefreshState {
  return { phase: 'boundary', task, at, finished: finishedSoFar(previous) + 1 };
}

/** Why a boundary refreshes: the lead asked, the context reached the threshold, or enough tasks were finished. */
type Cause =
  | { readonly kind: 'asked'; readonly by: string; readonly tokens: number | null }
  | { readonly kind: 'size'; readonly tokens: number }
  | { readonly kind: 'tasks'; readonly tokens: number; readonly finished: number };

function causeOf(facts: BoundaryFacts, settings: RefreshSettings, finished: number): Cause | undefined {
  if (facts.requestedBy !== undefined) {
    return { kind: 'asked', by: facts.requestedBy, tokens: facts.tokens ?? null };
  }
  const { tokens } = facts;
  if (tokens === undefined) {
    return undefined;
  }
  if (tokens >= settings.contextTokens) {
    return { kind: 'size', tokens };
  }
  const counted = settings.everyTasks > 0 && finished >= settings.everyTasks && tokens >= settings.everyTasksMinTokens;
  return counted ? { kind: 'tasks', tokens, finished } : undefined;
}

function whyOf(cause: Cause, settings: RefreshSettings): string {
  switch (cause.kind) {
    case 'size':
      return `your context is ${thousands(cause.tokens)} (refresh at ${thousands(settings.contextTokens)})`;
    case 'tasks':
      return `your context is ${thousands(cause.tokens)} after ${cause.finished} tasks (refresh every ${settings.everyTasks} tasks)`;
    case 'asked':
      return `${cause.by} asked for a refresh${cause.tokens === null ? '' : ` (your context is ${thousands(cause.tokens)})`}`;
  }
}

function handoverAsk(task: string, cause: Cause, context: StopContext): string {
  const why = whyOf(cause, context.settings);
  return (
    `${context.command}: ${why} and you just finished ${task}. Write your handover to ${context.handoverPath} ` +
    '(what is in progress, the next step of each, open questions, where things are), then run ' +
    `\`${readyCommand(context.command, context.session.id)}\`. Do not start new work.`
  );
}

/**
 * The Stop hook, at the end of every turn. Only a boundary (a task just finished) is judged, once:
 * at or over the threshold, after enough tasks at a context worth refreshing, or when the lead asked,
 * the session is kept going to write its handover;
 * otherwise the boundary is recorded as judged and nothing is said. Once the handover is written it
 * tells the user, once, that the session restarts by itself when it can, else that it waits for /clear.
 * While background work the session started still runs, a due refresh and the notice wait for a later
 * stop, since a fresh start would cut that work off. A stop that ends a turn a Stop hook continued never judges a boundary, so
 * the kit never loops; the notice that the handover is written does show there, since that is the
 * turn that runs `refresh --ready`.
 */
export function decideStop(state: RefreshState | undefined, context: StopContext, facts?: BoundaryFacts): StopDecision {
  if (state === undefined || !context.settings.enabled) {
    return NONE;
  }
  if (state.phase === 'ready') {
    if (state.noticed) {
      return NONE;
    }
    if (facts === undefined) {
      return MEASURE;
    }
    // A fresh start now would cut the running work off: the notice waits for a stop after it ends.
    if (facts.running > 0) {
      return NONE;
    }
    return noticeOf(state, context, context.canRestart);
  }
  if (state.phase !== 'boundary' || context.stopHookActive) {
    return NONE;
  }
  if (facts === undefined) {
    return MEASURE;
  }
  const tokens = facts.tokens ?? null;
  const cause = causeOf(facts, context.settings, state.finished);
  if (cause === undefined) {
    return { kind: 'write', state: { phase: 'idle', task: state.task, at: context.now, tokens, finished: state.finished } };
  }
  // A refresh would cut the running work off: the boundary stays unjudged, so a stop after the work ends judges it.
  if (facts.running > 0) {
    return NONE;
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
/** Starts after which the context is small again, so the task count starts over: a compaction too. */
const SMALL_SOURCES: ReadonlySet<string> = new Set([...FRESH_SOURCES, 'compact']);

export type StartDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'inject'; readonly note: string; readonly state: RefreshState }
  /** The context is small again: record the task count back at 0, say nothing. */
  | { readonly kind: 'reset'; readonly state: RefreshState };

/**
 * SessionStart: the first fresh start after the handover was written points the session at it, once.
 * Any start that leaves the context small (a compaction too) starts the task count over.
 */
export function decideStart(
  state: RefreshState | undefined,
  source: string | undefined,
  settings: Pick<RefreshSettings, 'enabled'>,
  handoverPath: string,
  now: string,
): StartDecision {
  if (!settings.enabled || state === undefined || source === undefined) {
    return { kind: 'none' };
  }
  if ((state.phase === 'boundary' || state.phase === 'idle') && state.finished > 0 && SMALL_SOURCES.has(source)) {
    return { kind: 'reset', state: { ...state, finished: 0 } };
  }
  if (state.phase !== 'ready' || !FRESH_SOURCES.has(source)) {
    return { kind: 'none' };
  }
  return {
    kind: 'inject',
    note: `You were refreshed after ${state.task}; read your handover first: ${handoverPath}`,
    state: { phase: 'refreshed', task: state.task, at: now },
  };
}
