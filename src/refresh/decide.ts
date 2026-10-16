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
  /** The session's Claude Code transcript, recorded with the notice so the fresh start can read what it leaves; null when Claude Code gave none. */
  readonly transcript: string | null;
}

/** What the Stop hook reads at a turn end that may ask for a refresh: a small file and the transcript's tail. */
export interface StopFacts {
  /** The name of the lead that asked for a refresh; undefined when nobody asked. */
  readonly requestedBy: string | undefined;
  /** The context size; undefined when the transcript does not tell, which never asks for a refresh. */
  readonly tokens: number | undefined;
  /** Read only once a refresh, or the notice that its handover is written, is due; undefined before. */
  readonly due: DueFacts | undefined;
}

/** What a due refresh, or the notice that its handover is written, reads before it acts. */
export interface DueFacts {
  /** The fingerprint of the handover file as it is now; null when there is none. */
  readonly handoverHash: string | null;
  /** Background work the session started that has not reported back (subagents, commands, monitors, workflows). */
  readonly running: number;
}

export type StopDecision =
  | { readonly kind: 'none' }
  /** Read the facts this stop lacks and decide again with them: the `StopFacts` first, their `due` facts once a refresh is due. */
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

/**
 * A session that goes on without the fresh start a refresh asked for (the user typed, or never typed /clear) is
 * asked again once its context grew this share of `contextTokens` past the size it was asked at, or at its next
 * task end: never at every turn end.
 */
export const REASK_SHARE = 0.2;

/** How far a context grows past a refresh it went on from before it is asked again. */
export function reaskGrowth(settings: Pick<RefreshSettings, 'contextTokens'>): number {
  return Math.round(settings.contextTokens * REASK_SHARE);
}

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
  const finished = state.task === null ? '' : ` finished ${state.task} and`;
  return {
    kind: 'notice',
    state: { ...state, noticed: true, transcript: context.transcript },
    message: `${context.command}: ${name}${finished} wrote its handover; ${next}`,
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

/** Why a turn end refreshes: the lead asked, the context reached the threshold, or enough tasks were finished. */
type Cause =
  | { readonly kind: 'asked'; readonly by: string; readonly tokens: number | null }
  | { readonly kind: 'size'; readonly tokens: number }
  | { readonly kind: 'tasks'; readonly tokens: number; readonly finished: number };

/** The context size a turn end asks at: the threshold, or after a refresh the session went on from, well past that ask. */
function askAt(state: RefreshState | undefined, settings: RefreshSettings): number {
  const asked = state?.phase === 'asked' || state?.phase === 'ready' ? state.tokens : null;
  return asked === null ? settings.contextTokens : Math.max(settings.contextTokens, asked + reaskGrowth(settings));
}

/**
 * Why this turn end refreshes, if it does: the lead asked, or the context reached `askAt`; at a task end
 * (`boundary`) also enough tasks at a context worth refreshing. A session asked before that went on is not
 * asked again for the lead's request it was already asked for.
 */
function causeOf(state: RefreshState | undefined, facts: StopFacts, settings: RefreshSettings): Cause | undefined {
  const askedBefore = state?.phase === 'asked' || state?.phase === 'ready';
  if (facts.requestedBy !== undefined && !askedBefore) {
    return { kind: 'asked', by: facts.requestedBy, tokens: facts.tokens ?? null };
  }
  const { tokens } = facts;
  if (tokens === undefined) {
    return undefined;
  }
  if (tokens >= askAt(state, settings)) {
    return { kind: 'size', tokens };
  }
  if (state?.phase !== 'boundary') {
    return undefined;
  }
  const counted = settings.everyTasks > 0 && state.finished >= settings.everyTasks && tokens >= settings.everyTasksMinTokens;
  return counted ? { kind: 'tasks', tokens, finished: state.finished } : undefined;
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

/** The ask to write the handover: after `task` at its end, or with null at another turn end. */
function handoverAsk(task: string | null, cause: Cause, context: StopContext): string {
  const why = whyOf(cause, context.settings);
  const when = task === null ? ', so refresh now rather than at a task end' : ` and you just finished ${task}`;
  return (
    `${context.command}: ${why}${when}. Write your handover to ${context.handoverPath} ` +
    '(what is in progress and the next step of each; what to check later, and when; questions still open with the user; ' +
    'the scratchpad files, plan file and scheduled jobs the next session still needs; where things are), then run ' +
    `\`${readyCommand(context.command, context.session.id)}\`. Do not start new work.`
  );
}

/**
 * The Stop hook, at the end of every turn. A turn end with the context at the threshold, or after the lead
 * asked, keeps the session going to write its handover, so a long task refreshes before Claude Code compacts
 * it; a task end (a `boundary`, judged once) also does after enough tasks at a context worth refreshing, and
 * is recorded as judged when none is due. A session that went on after an ask (the user typed, or never typed
 * /clear) is asked again only once its context grew `reaskGrowth` past that ask, or at its next task end. Once
 * the handover is written it tells the user, once, that the session restarts by itself when it can, else that
 * it waits for /clear. While background work the session started still runs, a due refresh and the notice wait
 * for a later stop, since a fresh start would cut that work off. A stop that ends a turn a Stop hook continued
 * never asks, so the kit never loops; the notice that the handover is written does show there, since that is
 * the turn that runs `refresh --ready`. The facts are read cheapest first: the running work, which takes the
 * transcript's last 8 MiB, only once a refresh or the notice is due.
 */
export function decideStop(state: RefreshState | undefined, context: StopContext, facts?: StopFacts): StopDecision {
  if (!context.settings.enabled) {
    return NONE;
  }
  if (state?.phase === 'ready' && !state.noticed) {
    const due = facts?.due;
    if (due === undefined) {
      return MEASURE;
    }
    // A fresh start now would cut the running work off: the notice waits for a stop after it ends.
    return due.running > 0 ? NONE : noticeOf(state, context, context.canRestart);
  }
  if (context.stopHookActive) {
    return NONE;
  }
  if (facts === undefined) {
    return MEASURE;
  }
  const tokens = facts.tokens ?? null;
  const cause = causeOf(state, facts, context.settings);
  if (cause === undefined) {
    return state?.phase === 'boundary' ? { kind: 'write', state: { phase: 'idle', task: state.task, at: context.now, tokens, finished: state.finished } } : NONE;
  }
  if (facts.due === undefined) {
    return MEASURE;
  }
  // A refresh would cut the running work off: a boundary stays unjudged, so a stop after the work ends asks.
  if (facts.due.running > 0) {
    return NONE;
  }
  const task = state?.phase === 'boundary' ? state.task : null;
  return {
    kind: 'block',
    state: { phase: 'asked', task, at: context.now, tokens, handoverHash: facts.due.handoverHash },
    reason: handoverAsk(task, cause, context),
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
      reason:
        'no refresh was asked of you: one is asked at a turn end with your context over the threshold, at a task end after enough tasks, ' +
        'or after the lead asked for it',
    };
  }
  if (handover === undefined || handover.trim() === '') {
    return { kind: 'refused', reason: `write your handover to ${handoverPath} first` };
  }
  if (handoverHashOf(handover) === state.handoverHash) {
    return { kind: 'refused', reason: `${handoverPath} is the handover from before; write this refresh's handover there` };
  }
  return {
    kind: 'ready',
    state: { phase: 'ready', task: state.task, at: now, tokens: state.tokens, noticed: false, transcript: null, claudePid: null },
  };
}

/** Starts that drop the old context; a `compact`, `resume` or `fork` start keeps it, so the handover waits. */
const FRESH_SOURCES: ReadonlySet<string> = new Set(['clear', 'startup']);
/** Starts after which the context is small again, so the task count starts over: a compaction too. */
const SMALL_SOURCES: ReadonlySet<string> = new Set([...FRESH_SOURCES, 'compact']);

export type StartDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'inject'; readonly note: string; readonly state: RefreshState }
  /** The context is small again: record the task count back at 0, or forget the size a refresh was asked at; say nothing. */
  | { readonly kind: 'reset'; readonly state: RefreshState };

/**
 * SessionStart: the first fresh start after the handover was written points the session at it, once.
 * Any start that leaves the context small (a compaction too) starts the task count over, and forgets the
 * size a refresh the session went on from was asked at, so its next ask comes at the threshold again.
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
  if (state.phase === 'ready' && FRESH_SOURCES.has(source)) {
    const after = state.task === null ? 'mid-task' : `after ${state.task}`;
    return {
      kind: 'inject',
      note: `You were refreshed ${after}; read your handover first: ${handoverPath}. Then carry on with its next steps.`,
      state: { phase: 'refreshed', task: state.task, at: now },
    };
  }
  if ((state.phase === 'asked' || state.phase === 'ready') && state.tokens !== null && SMALL_SOURCES.has(source)) {
    return { kind: 'reset', state: { ...state, tokens: null } };
  }
  return { kind: 'none' };
}

/**
 * How long after a /clear took the refresh the background wake still answers to it: the wake runs beside the
 * SessionStart hook that takes it, so a refresh taken earlier belongs to another start.
 */
export const WAKE_WINDOW_MS = 30_000;

/**
 * The prompt that wakes a session /clear just started from its refresh, so it carries on instead of sitting idle
 * until the user types; undefined when this start took no refresh.
 */
export function wakePromptOf(state: RefreshState | undefined, handoverPath: string, now: string): string | undefined {
  if (state?.phase !== 'refreshed') {
    return undefined;
  }
  const age = Date.parse(now) - Date.parse(state.at);
  if (!(age >= 0 && age <= WAKE_WINDOW_MS)) {
    return undefined;
  }
  const at = state.task === null ? '' : ` at ${state.task}`;
  return `You were started fresh after your context refresh${at}: read your handover ${handoverPath} now, take over what the SessionStart note lists, then carry on with its next steps.`;
}
