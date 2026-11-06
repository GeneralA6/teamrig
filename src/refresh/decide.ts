import type { RefreshConfig } from '../config/types.ts';
import { sessionDisplay } from '../core/ids.ts';
import { lineHash } from '../inbox/line-hash.ts';
import type { RefreshState } from './state.ts';

/**
 * The context-refresh rules, as pure functions of the session's state, what was measured, the
 * team's settings and the time: the hooks and commands only read and write what these decide.
 */

export type RefreshSettings = Pick<
  RefreshConfig,
  'enabled' | 'contextTokens' | 'everyTasks' | 'everyTasksMinTokens' | 'tabTitle' | 'restartDelaySeconds' | 'compactCeilingTokens'
>;

/** A session whose handover is written, waiting for its fresh start. */
export type ReadyState = Extract<RefreshState, { readonly phase: 'ready' }>;

/** What the Stop hook knows before it reads anything but the session's state file. */
export interface StopContext {
  /** Claude Code's `stop_hook_active`: this stop ends a turn a Stop hook already continued. */
  readonly stopHookActive: boolean;
  readonly settings: RefreshSettings;
  readonly now: string;
  readonly session: { readonly id: string; readonly team: string; readonly name: string };
  readonly handoverPath: string;
  /** The CLI's name, as the session runs it from its Bash tool. */
  readonly command: string;
  /** The hook can restart the session once its handover is written: `refresh.autoRestart` is on and Claude Code gave what it needs. */
  readonly canRestart: boolean;
  /** The session's Claude Code transcript, recorded with the notice so the fresh start can read what it leaves; null when Claude Code gave none. */
  readonly transcript: string | null;
}

/** What an ask for the handover names, at a turn end or at a tool result within a turn. */
export type AskContext = Pick<StopContext, 'settings' | 'now' | 'session' | 'handoverPath' | 'command'>;

/** What the Stop hook reads at a turn end that may ask for a refresh: a small file and the transcript's tail. */
export interface StopFacts {
  /** The name of the lead that asked for a refresh; undefined when nobody asked. */
  readonly requestedBy: string | undefined;
  /** The context size; undefined when the transcript does not tell, which never asks for a refresh. */
  readonly tokens: number | undefined;
  /**
   * The session is in an open owner meeting, which holds its refresh (`meetingHolds`): the lead's daily meeting
   * (src/meeting/state.ts `inMeeting`), or a booked one it is met in or joins (src/meeting/schedule.ts `inBookedMeeting`).
   */
  readonly meeting: boolean;
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
  /** Tell the user the session restarts by itself once idle (`restart`), once work comes, or waits for /clear; `title` marks the tab when the team wants it. */
  | { readonly kind: 'notice'; readonly state: ReadyState; readonly message: string; readonly title: string | undefined; readonly restart: boolean };

export type NoticeDecision = Extract<StopDecision, { readonly kind: 'notice' }>;

/**
 * What follows a written handover: the automatic restart once the session is idle, the restart held back until a
 * wake brings the session work (T1383), or the user's /clear.
 */
export type NoticeNext = 'restart' | 'park' | 'clear';

/** What the plugin's mod gives at a tool result of the main conversation, the context Claude Code last reported, and the due facts once a refresh is due. */
export interface MidTurnFacts {
  readonly tokens: number;
  /** The session is in an open owner meeting, as at a turn end. */
  readonly meeting: boolean;
  readonly due: DueFacts | undefined;
}

export type MidTurnDecision =
  /** No ask now; `nextAt` is the context the mod asks again at, null when it need not (the refresh is off). */
  | { readonly kind: 'none'; readonly nextAt: number | null }
  /** Read the due facts and decide again with them. */
  | { readonly kind: 'measure' }
  /** Record `state` and add `reason` to the tool result the model reads next. */
  | { readonly kind: 'ask'; readonly state: RefreshState; readonly reason: string; readonly nextAt: number };

/** What a compaction Claude Code is about to run on the main conversation reads: its own estimate of the context, and the window. */
export interface CompactFacts {
  readonly tokens: number;
  readonly window: number;
}

export type CompactDecision = { readonly kind: 'go' } | { readonly kind: 'skip'; readonly reason: string };

const NONE: StopDecision = { kind: 'none' };
const MEASURE: StopDecision = { kind: 'measure' };
const GO: CompactDecision = { kind: 'go' };

/**
 * A session that goes on without the fresh start a refresh asked for (the user typed, or never typed /clear) is
 * asked again once its context grew this share of `contextTokens` past the size it was asked at, or at its next
 * task end: never at every turn end.
 */
export const REASK_SHARE = 0.2;

/**
 * An open owner meeting holds the refresh of each session in it (the lead in its daily meeting; the session met and
 * those joining in a booked one): no ask, no notice and so no restart, which would cut the meeting off, until the
 * turn end after `meeting end` (or the meeting's lapse), which asks at once when the context is past the threshold.
 * Up to `compactCeilingTokens` only: past it the refresh goes
 * on even in the meeting, as Claude Code's own compaction does (`decideCompact`), so the session never runs out of
 * room in it. Under it, only a handover asked for or written stops that compaction, so a session the meeting kept
 * from being asked still compacts when Claude Code needs room. 0, which never stops a compaction, sets no ceiling;
 * a size the transcript does not tell is held.
 */
export function meetingHolds(settings: Pick<RefreshSettings, 'compactCeilingTokens'>, meeting: boolean, tokens: number | undefined): boolean {
  const ceiling = settings.compactCeilingTokens;
  return meeting && (ceiling === 0 || tokens === undefined || tokens < ceiling);
}

/** How far a context grows past a refresh it went on from before it is asked again. */
export function reaskGrowth(settings: Pick<RefreshSettings, 'contextTokens'>): number {
  return Math.round(settings.contextTokens * REASK_SHARE);
}

/** Tokens as people say them: 262,144 is `262k`. */
export function thousands(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

/** What the notice says comes next, and the tab mark for it. */
const NEXT_TEXT: Readonly<Record<NoticeNext, (context: StopContext) => { readonly text: string; readonly mark: string }>> = {
  restart: (context) => ({
    text: `${context.command} starts it fresh once it has been idle ${context.settings.restartDelaySeconds} s (type anything to keep this context)`,
    mark: 'restarting',
  }),
  park: (context) => ({
    text: `it has no work it can start now, so ${context.command} starts it fresh once a wake brings it some (type anything to keep this context)`,
    mark: 'waits for work',
  }),
  clear: () => ({ text: 'type /clear for a fresh start', mark: 'type /clear' }),
};

/** The notice that `state`'s handover is written, and what comes `next`. */
export function noticeOf(state: ReadyState, context: StopContext, next: NoticeNext): NoticeDecision {
  const { name } = context.session;
  const { text, mark } = NEXT_TEXT[next](context);
  const finished = state.task === null ? '' : ` finished ${state.task} and`;
  return {
    kind: 'notice',
    state: { ...state, noticed: true, transcript: context.transcript },
    message: `${context.command}: ${name}${finished} wrote its handover; ${text}`,
    title: context.settings.tabTitle ? `${sessionDisplay(context.session.team, name)}: ${mark}` : undefined,
    restart: next === 'restart',
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

/**
 * Why a turn end refreshes: the lead asked, the context reached the threshold, enough tasks were finished, or a
 * tool result asked within the turn (`pending`) and the turn ended with no handover marked ready.
 */
type Cause =
  | { readonly kind: 'asked'; readonly by: string; readonly tokens: number | null }
  | { readonly kind: 'size'; readonly tokens: number }
  | { readonly kind: 'tasks'; readonly tokens: number; readonly finished: number }
  | { readonly kind: 'pending'; readonly tokens: number | null };

/** The context size a turn end, or a tool result within a turn, asks at: the threshold, or after a refresh the session went on from, well past that ask. */
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
    case 'pending':
      return `the refresh asked within this turn${cause.tokens === null ? '' : ` at ${thousands(cause.tokens)}`} is still due`;
  }
}

/** Where the ask finds the session: at a turn end (after `task`, or with null another turn end), or at a tool result within a turn. */
type AskMoment = { readonly kind: 'turnEnd'; readonly task: string | null } | { readonly kind: 'midTurn' };

function whenOf(moment: AskMoment): string {
  if (moment.kind === 'midTurn') {
    return ', so refresh within this turn: finish the step you are on and start no other';
  }
  return moment.task === null ? ', so refresh now rather than at a task end' : ` and you just finished ${moment.task}`;
}

/**
 * What the ask adds while background work the session started still runs: the handover says what each result still
 * needs, since the fresh start, which waits for the work to report back, does not see that result.
 */
function runningLine(running: number): string {
  if (running === 0) {
    return '';
  }
  return running === 1
    ? 'A background task you started still runs: say in the handover what its result still needs; the fresh start waits until it reports back. '
    : `${running} background tasks you started still run: say in the handover what each result still needs; the fresh start waits until they report back. `;
}

/**
 * The ask to write the handover. It asks only for what the register lacks: the fresh start lists the session's
 * tasks live from the register (hooks/live-tasks.ts), so a status restated here could only go stale. Within a turn
 * it ends the turn after `refresh --ready`, since the fresh start comes only once the turn has ended. It never waits
 * for `running` background work (T1378): a session that runs its queued steps in the background would reach Claude
 * Code's compaction unasked; only the fresh start, which would cut that work off, waits for it.
 */
function handoverAsk(moment: AskMoment, cause: Cause, context: AskContext, running: number): string {
  const why = whyOf(cause, context.settings);
  const after = moment.kind === 'midTurn' ? ' and end your turn: the fresh start follows it.' : '. Do not start new work.';
  return (
    `${context.command}: ${why}${whenOf(moment)}. Write your handover to ${context.handoverPath}, replacing the whole file (your fresh start reads all of it): what the register lacks ` +
    '(the next step of each task in progress; what to check later, and when; questions still open with the user; ' +
    'the scratchpad files, plan file and scheduled jobs the next session still needs; where things are), not task statuses, ' +
    `which your fresh start reads live from the register. ${runningLine(running)}Then run \`${readyCommand(context.command, context.session.id)}\`${after}`
  );
}

/**
 * The Stop hook, at the end of every turn. A turn end with the context at the threshold, or after the lead
 * asked, keeps the session going to write its handover, so a long task refreshes before Claude Code compacts
 * it; a task end (a `boundary`, judged once) also does after enough tasks at a context worth refreshing, and
 * is recorded as judged when none is due. A session that went on after an ask (the user typed, or never typed
 * /clear) is asked again only once its context grew `reaskGrowth` past that ask, or at its next task end. Once
 * the handover is written it tells the user, once, that the session restarts by itself when it can, else that
 * it waits for /clear. While background work the session started still runs, the notice waits for a later stop,
 * since a fresh start would cut that work off; a due refresh asks anyway and names the work (`handoverAsk`). Both
 * wait while an owner meeting the session is in is open (`meetingHolds`). A stop that ends a turn a Stop hook continued
 * never asks, so the kit never loops; the notice that the handover is written does show there, since that is
 * the turn that runs `refresh --ready`. A turn that ends after a tool result asked within it (`decideMidTurn`),
 * with no handover marked ready, is asked once more, as a due refresh. The facts are read cheapest first: the
 * running work, which takes the transcript's last 8 MiB, only once a refresh or the notice is due.
 */
export function decideStop(state: RefreshState | undefined, context: StopContext, facts?: StopFacts): StopDecision {
  if (!context.settings.enabled) {
    return NONE;
  }
  if (state?.phase === 'ready' && !state.noticed) {
    if (facts === undefined) {
      return MEASURE;
    }
    // A fresh start now would cut the open meeting off: the notice, and so the restart, waits for its end.
    if (meetingHolds(context.settings, facts.meeting, facts.tokens)) {
      return NONE;
    }
    if (facts.due === undefined) {
      return MEASURE;
    }
    // A fresh start now would cut the running work off: the notice waits for a stop after it ends.
    return facts.due.running > 0 ? NONE : noticeOf(state, context, context.canRestart ? 'restart' : 'clear');
  }
  if (context.stopHookActive) {
    return NONE;
  }
  if (facts === undefined) {
    return MEASURE;
  }
  const held = meetingHolds(context.settings, facts.meeting, facts.tokens);
  if (state?.phase === 'asked' && state.midTurn) {
    return held ? NONE : pendingAsk(state, context, facts.due);
  }
  const tokens = facts.tokens ?? null;
  const cause = causeOf(state, facts, context.settings);
  if (cause === undefined) {
    return state?.phase === 'boundary' ? { kind: 'write', state: { phase: 'idle', task: state.task, at: context.now, tokens, finished: state.finished } } : NONE;
  }
  // The open meeting holds the ask: a boundary stays unjudged, so the turn end after the meeting asks.
  if (held) {
    return NONE;
  }
  if (facts.due === undefined) {
    return MEASURE;
  }
  const task = state?.phase === 'boundary' ? state.task : null;
  return {
    kind: 'block',
    state: { phase: 'asked', task, at: context.now, tokens, handoverHash: facts.due.handoverHash, midTurn: false },
    reason: handoverAsk({ kind: 'turnEnd', task }, cause, context, facts.due.running),
  };
}

/**
 * The turn end after a tool result asked within the turn, the handover not marked ready: asked once more, as the
 * Stop hook's own ask. It keeps the first ask's fingerprint, so a handover written since still counts as new.
 */
function pendingAsk(state: Extract<RefreshState, { readonly phase: 'asked' }>, context: StopContext, due: DueFacts | undefined): StopDecision {
  if (due === undefined) {
    return MEASURE;
  }
  return {
    kind: 'block',
    state: { ...state, midTurn: false },
    reason: handoverAsk({ kind: 'turnEnd', task: state.task }, { kind: 'pending', tokens: state.tokens }, context, due.running),
  };
}

/**
 * The plugin's mod, at a tool result of the main conversation: once the context Claude Code reported reaches
 * `askAt` (the threshold, or well past an ask the session went on from), it asks for the handover within the
 * turn, so a long busy turn refreshes before Claude Code compacts it rather than after. Only the size asks here:
 * the lead's request and the task count stay with the turn's end. The open meeting the session is in holds the
 * ask (`meetingHolds`); background work still running does not, and the ask names it. `nextAt` tells the mod the
 * context to look again at, so it calls the CLI only then; a held ask it looks at again a while later.
 */
export function decideMidTurn(state: RefreshState | undefined, context: AskContext, facts: MidTurnFacts): MidTurnDecision {
  const { settings } = context;
  if (!settings.enabled) {
    return { kind: 'none', nextAt: null };
  }
  const nextAt = askAt(state, settings);
  if (facts.tokens < nextAt || meetingHolds(settings, facts.meeting, facts.tokens)) {
    return { kind: 'none', nextAt };
  }
  if (facts.due === undefined) {
    return { kind: 'measure' };
  }
  const task = state?.phase === 'boundary' ? state.task : null;
  const asked: RefreshState = { phase: 'asked', task, at: context.now, tokens: facts.tokens, handoverHash: facts.due.handoverHash, midTurn: true };
  const reason = handoverAsk({ kind: 'midTurn' }, { kind: 'size', tokens: facts.tokens }, context, facts.due.running);
  return { kind: 'ask', state: asked, reason, nextAt: askAt(asked, settings) };
}

/**
 * A compaction Claude Code is about to run on its own (trigger `auto`) on the main conversation: skipped while the
 * session's handover is asked for or written, since the refresh's fresh start replaces it (the /clear once the turn
 * ended and the person at the tab let it go, or the user's), as long as Claude
 * Code's estimate of the context is under `compactCeilingTokens`. Past the ceiling it goes, so a session never runs
 * out of room: a prompt too long for the window, which compacts with the same trigger, is past it too. A ceiling
 * at or past the window would not leave that room, so it skips nothing.
 */
export function decideCompact(state: RefreshState | undefined, context: Pick<AskContext, 'settings' | 'command'>, facts: CompactFacts): CompactDecision {
  const { enabled, compactCeilingTokens: ceiling } = context.settings;
  const pending = state?.phase === 'asked' || state?.phase === 'ready';
  if (!enabled || !pending || ceiling === 0 || ceiling >= facts.window || facts.tokens >= ceiling) {
    return GO;
  }
  const handover = state.phase === 'asked' ? 'asked for' : 'written';
  return {
    kind: 'skip',
    reason: `${context.command}: the handover is ${handover} and the fresh start follows this turn, so compaction waits until ${thousands(ceiling)} (now ${thousands(facts.tokens)})`,
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
 * no modification times, so the fingerprint stands for "written since"), and is at most `maxBytes` long (0: no cap),
 * since the fresh start reads all of it.
 */
export function decideReady(
  state: RefreshState | undefined,
  handover: string | undefined,
  handoverPath: string,
  now: string,
  maxBytes: RefreshConfig['handoverMaxBytes'],
): ReadyDecision {
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
  const bytes = Buffer.byteLength(handover, 'utf8');
  if (maxBytes > 0 && bytes > maxBytes) {
    return {
      kind: 'refused',
      reason:
        `${handoverPath} is ${bytes.toLocaleString('en-US')} bytes, over refresh.handoverMaxBytes (${maxBytes.toLocaleString('en-US')}): ` +
        'your fresh start reads all of it. Rewrite it whole, short, with only what your next session needs',
    };
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
 * SessionStart: the first fresh start after the handover was written points the session at it, once, and says
 * that Claude Code keeps no read from before it: an Edit or Write of a file the new session has not read with the
 * Read tool fails, and that was the most common failed call in one team's week (T1380).
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
      note:
        `You were refreshed ${after}; read your handover first: ${handoverPath}. Then carry on with its next steps. ` +
        'Read a file with the Read tool before you Edit or Write it: a read by cat or sed, or one before the refresh, does not count.',
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
