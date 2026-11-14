import type { BudgetConfig, OverAction, QuietHours } from '../config/types.ts';
import { KIT_NAME } from '../core/home.ts';
import { formatUtcDay, isMinuteInSpan, MS_PER_DAY, MS_PER_MINUTE, utcMinuteOf } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import type { Burst } from './burst.ts';
import { budgetMarkOf, burstPromptLines, burstStopLines, type BurstMarks, type SurplusHint } from './burst-lines.ts';
import { cutClause, type Cut } from './cut.ts';
import { formatEndTime, formatPct, noRoomText } from './format.ts';
import { liftedLine, type Lift, type LiftNames } from './lift.ts';
import { holdsPastPart, type PaceReading, type TeamDay } from './pace.ts';

/**
 * The live budget warning, pure: from a session's use today and the team's pace, which line its
 * person sees at a turn's end, which line the model gets with the next prompt, whether its leader gets
 * an inbox line, and whether a helper launch goes ahead, asks the person or is refused. Lines come
 * only at crossings, each once, so a session sees a few a day and none on most turns. A burst's lines
 * (`burst-lines.ts`) come the same way: at its start and end, and the lead's surplus line once a week.
 */

/** Past the last warning level, a line at every further step of this many % of the daily budget. */
export const WARN_STEP_PCT = 25;

const BUDGET_COMMAND = `${KIT_NAME} budget`;

export const MORE = `More: ${BUDGET_COMMAND}`;

/** What the hooks know of one session's budget at one moment. */
export interface BudgetFacts extends LiftNames {
  readonly now: number;
  readonly id: string;
  readonly name: string;
  /** Its use since 00:00 UTC, in % of the week. */
  readonly usedTodayPct: number;
  /** The W that make 1% of the week in `usedTodayPct`, so a cost in W reads on the same scale. */
  readonly todayWPerPct: number;
  /** Its daily budget in % of the week: its lift's while lifted, at least its burst's while in a burst. */
  readonly budgetPct: number;
  readonly lift: Lift | undefined;
  /** A leader's cut of the session in force (`teamrig budget cut`): past its budget it is held whatever room the team has. */
  readonly cut: Cut | undefined;
  /** The leader that gave the cut in force; undefined without one. */
  readonly cutBy: BudgetLeader | undefined;
  /** The burst in force, when the session is in it. */
  readonly burst: Burst | undefined;
  /** A short day funds none of its work (src/budget/pause.ts `isPaused`), so its budget is 0 unless a burst holds it up. */
  readonly paused: boolean;
  /** For the lead only, with no burst in force: a surplus worth one. */
  readonly surplus: SurplusHint | undefined;
  /** The week's use, in %. */
  readonly weekUsedPct: number;
  readonly pace: PaceReading | undefined;
  /** Everyone's use today against the team's in-day pace: below it, the team has room and no session is held. */
  readonly teamDay: TeamDay;
  /** The session is the team's lead: it lifts budgets, so its own helpers never ask and it gets no inbox line. */
  readonly isLead: boolean;
  /** Its open and in-progress p0 task ids: urgent work that goes on past the daily stop, helpers too. */
  readonly urgent: readonly string[];
  /**
   * The answers other sessions wait on it for (`QueuedWork.awaited`): a wait on it blocks another session, so they go on
   * past the daily stop as p0 work does, helpers too (T2656).
   */
  readonly awaited: readonly string[];
  /** Who gets the session's inbox line when it escalates: its own leader; undefined for the lead, which gets none. */
  readonly leader: BudgetLeader | undefined;
  /** The team's zone, which the lines print their times in. */
  readonly zone: TimeZone;
}

/** A session's own leader in the team's lead tree (the sub-lead that lists it, else the lead), by id and name. */
export interface BudgetLeader {
  readonly id: string;
  readonly name: string;
  /** The leader is the team's lead, which the lines call "the lead"; a sub-lead they name. Either lifts the session's budget. */
  readonly isLead: boolean;
}

export type WarnBudget = Pick<BudgetConfig, 'warnAtPct' | 'overAction' | 'escalate' | 'quietHours'>;

/** What a session was already shown, so each line shows once; the burst marks cross midnight. */
export interface WarnState extends BurstMarks {
  /** The UTC day the marks below count for; a new day starts them over. */
  readonly day: string;
  /** The highest warning level (in % of the daily budget) shown today; 0 for none. */
  readonly level: number;
  /** The level at which the model was last told it is past budget; 0 for never today. */
  readonly modelLevel: number;
  /** The team was ahead of its pace line at the last turn's end. */
  readonly ahead: boolean;
  /** The session was held (`isHeld`) at the last turn's end. */
  readonly held: boolean;
  /** The session had escalated (held, and the team ahead, escalating on the session alone or a leader's cut) at the last turn's end. */
  readonly escalated: boolean;
  /** The session's leader got today's inbox line about it (the lead's, before sub-leads, hence the name). */
  readonly leadTold: boolean;
  /** When the quiet hours whose line was shown began, epoch ms. */
  readonly quietFrom: number | undefined;
  /** The `at` of the lift whose line was shown; undefined once its end was shown. */
  readonly liftAt: number | undefined;
}

export function emptyWarnState(day: string): WarnState {
  return { day, level: 0, modelLevel: 0, ahead: false, held: false, escalated: false, leadTold: false, quietFrom: undefined, liftAt: undefined, burstAt: undefined, modelBurstAt: undefined, surplusShown: undefined };
}

/** The state for `now`'s day: a new day keeps only the quiet-hours, lift and burst marks, which cross midnight. */
function stateFor(state: WarnState | undefined, now: number): WarnState {
  const day = formatUtcDay(new Date(now));
  if (state === undefined) {
    return emptyWarnState(day);
  }
  if (state.day === day) {
    return state;
  }
  const { quietFrom, liftAt, burstAt, modelBurstAt, surplusShown } = state;
  return { ...emptyWarnState(day), quietFrom, liftAt, burstAt, modelBurstAt, surplusShown };
}

/**
 * The session's use today, with `extraPct` more of the week spent, in % of its daily budget; any use counts as past a
 * budget of 0.
 */
function budgetUsePct(facts: BudgetFacts, extraPct = 0): number {
  const usedPct = facts.usedTodayPct + extraPct;
  if (facts.budgetPct > 0) {
    return (usedPct / facts.budgetPct) * 100;
  }
  return usedPct > 0 ? Number.POSITIVE_INFINITY : 0;
}

/**
 * The highest warning level reached: one of `warnAtPct`, or past the last of them a further step of
 * `WARN_STEP_PCT`; 0 below the first. Past every level by an unbounded amount, the last level.
 */
export function levelOf(usePct: number, warnAtPct: readonly number[]): number {
  const levels = [...warnAtPct].sort((a, b) => a - b);
  const first = levels[0];
  const last = levels.at(-1);
  if (first === undefined || last === undefined || usePct < first) {
    return 0;
  }
  if (usePct < last) {
    return levels.filter((level) => level <= usePct).at(-1) ?? 0;
  }
  return Number.isFinite(usePct) ? last + Math.floor((usePct - last) / WARN_STEP_PCT) * WARN_STEP_PCT : last;
}

/** A stretch of quiet hours, epoch ms. */
export interface QuietSpan {
  readonly from: number;
  readonly to: number;
}

const MINUTES_PER_DAY = MS_PER_DAY / MS_PER_MINUTE;

/** The quiet hours `now` falls in, epoch ms; undefined outside them. They may cross midnight. */
export function quietSpanOf(quiet: QuietHours | undefined, now: number): QuietSpan | undefined {
  const start = quiet === undefined ? undefined : utcMinuteOf(quiet.startUtc);
  const end = quiet === undefined ? undefined : utcMinuteOf(quiet.endUtc);
  if (start === undefined || end === undefined || start === end) {
    return undefined;
  }
  const dayStart = now - (now % MS_PER_DAY);
  const minute = Math.floor((now - dayStart) / MS_PER_MINUTE);
  if (!isMinuteInSpan(minute, start, end)) {
    return undefined;
  }
  const from = (minute >= start ? dayStart : dayStart - MS_PER_DAY) + start * MS_PER_MINUTE;
  return { from, to: from + ((end - start + MINUTES_PER_DAY) % MINUTES_PER_DAY) * MS_PER_MINUTE };
}

/** Where a session stands now. */
interface Standing {
  readonly over: boolean;
  readonly level: number;
  readonly ahead: boolean;
  /** Past budget while the team has no room today, or under a leader's cut (`isHeld`). */
  readonly held: boolean;
  /** Held, and (unless the team escalates on the session alone or a leader cut it) the team is ahead of its pace line. */
  readonly escalated: boolean;
  /** The current quiet hours, unless the session's lift exempts it from them. */
  readonly quiet: QuietSpan | undefined;
}

/**
 * True when the session's use today is past its daily budget (its lift's while lifted), or would be once it spends
 * `extraPct` more of the week.
 */
export function isPastDailyBudget(facts: BudgetFacts, extraPct = 0): boolean {
  return budgetUsePct(facts, extraPct) > 100;
}

/**
 * True when the session is past its daily budget while the team has no room today (its use at or past its in-day
 * pace, `hasRoom`), or while a leader's cut of it is in force (`holdsPastPart`, by which `teamrig budget` names its
 * holds too): only then is it held, woken for urgent work alone and
 * escalated as `budget.escalate` says (a cut escalates it whatever that says). While the team has room, a session past
 * its part uses room the others left, so no session waits while the week has room, unless its leader cut it to its
 * own part (T1616). A turn about to start counts as spent (`extraPct`, in % of the week), for the session and for the
 * team: a session with next to nothing left, idle since the night, is held before its wake, not after the wake's own
 * turn spent it; and as the quiet hours end the in-day pace is the night's use alone, so the team's room is a few
 * seconds of pace, which the wake's turn would spend at once (T1322).
 */
export function isHeld(facts: BudgetFacts, extraPct = 0): boolean {
  return isPastDailyBudget(facts, extraPct) && holdsPastPart({ ...facts.teamDay, usedPct: facts.teamDay.usedPct + extraPct }, facts.cut !== undefined);
}

/** The quiet hours the session is in; undefined outside them, or while its lift exempts it. */
export function sessionQuietSpan(facts: BudgetFacts, quiet: QuietHours | undefined): QuietSpan | undefined {
  return facts.lift?.quietHoursExempt === true ? undefined : quietSpanOf(quiet, facts.now);
}

function standingOf(facts: BudgetFacts, budget: WarnBudget): Standing {
  const usePct = budgetUsePct(facts);
  const over = isPastDailyBudget(facts);
  const held = isHeld(facts);
  const ahead = facts.pace?.state === 'ahead';
  const quiet = sessionQuietSpan(facts, budget.quietHours);
  const escalated = held && (budget.escalate === 'session' || ahead || facts.cut !== undefined);
  return { over, level: levelOf(usePct, budget.warnAtPct), ahead, held, escalated, quiet };
}

/** How strongly an action holds a helper launch back: only "ask" and "block" do. */
function gateRank(action: OverAction): number {
  switch (action) {
    case 'warn':
    case 'ask-lead':
      return 0;
    case 'ask':
      return 1;
    case 'block':
      return 2;
  }
}

/** What happens to new helpers under `action`, as a clause; undefined when nothing does. */
function helperClause(action: OverAction): string | undefined {
  switch (action) {
    case 'warn':
    case 'ask-lead':
      return undefined;
    case 'ask':
      return 'new helpers ask first';
    case 'block':
      return 'new helpers are refused';
  }
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function teamText(facts: BudgetFacts): string {
  const pace = facts.pace;
  if (pace === undefined) {
    return `Team: ${formatPct(facts.weekUsedPct)} of the week used.`;
  }
  return `Team: ${formatPct(facts.weekUsedPct)} used, pace line ${formatPct(pace.linePct)}.`;
}

/** "the team is 1.3 points ahead of its pace line" */
function aheadClause(facts: BudgetFacts): string {
  return `the team is ${(facts.pace?.gapPts ?? 0).toFixed(1)} points ahead of its pace line`;
}

/** Why a held session is held: its leader's cut, else the team has no room today, and the week's pace when it is ahead. */
function heldClause(facts: BudgetFacts, standing: Standing): string {
  if (facts.cut !== undefined) {
    return cutClause(facts.cut, leaderText(facts.cutBy, 'its'), facts.zone);
  }
  const noRoom = noRoomText(facts.teamDay);
  return standing.ahead ? `${noRoom}, and ${aheadClause(facts)}` : noRoom;
}

function roomText(facts: BudgetFacts): string {
  return `The team has room today: ${formatPct(facts.teamDay.usedPct)} of the week used, below its in-day pace of ${formatPct(facts.teamDay.pacePct)}, so nothing more happens.`;
}

/** The work that goes on past the daily stop, its p0 work and the answers others wait on, and whether it reads as plural. */
interface PastStopWork {
  readonly text: string;
  readonly plural: boolean;
}

/** The session's work that goes on past the daily stop, in the voice `whose` speaks; undefined when it has none. */
function pastStopWork(facts: BudgetFacts, whose: 'its' | 'your'): PastStopWork | undefined {
  const parts: string[] = [];
  if (facts.urgent.length > 0) {
    parts.push(`${whose} p0 work (${facts.urgent.join(', ')})`);
  }
  if (facts.awaited.length > 0) {
    parts.push(`the answers other sessions wait on ${whose === 'its' ? 'it' : 'you'} for (${facts.awaited.join(', ')})`);
  }
  // Only p0 work alone reads as one thing: the answers are many, and the two together are too.
  return parts.length === 0 ? undefined : { text: parts.join(' and '), plural: facts.awaited.length > 0 };
}

/** What escalation does for this session, as sentences; '' with `warn` or for the lead, and without a part to say. */
function escalatedText(facts: BudgetFacts, budget: WarnBudget): string {
  if (facts.isLead || budget.overAction === 'warn') {
    return '';
  }
  const goesOn = pastStopWork(facts, 'its');
  const helpers = goesOn === undefined ? helperClause(budget.overAction) : `${goesOn.text} ${goesOn.plural ? 'go' : 'goes'} on past the stop, helpers too`;
  // A leader gave the cut, so no inbox line tells it.
  const told = facts.cut === undefined ? toldText(facts.leader) : undefined;
  const parts = [helpers, told].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? '' : `${capitalized(parts.join('; '))}.`;
}

/** The session's leader in its lines: `the lead`, or for a sub-lead's member `its leader <name>` (`your leader <name>` to the model). */
function leaderText(leader: BudgetLeader | undefined, whose: 'its' | 'your'): string {
  return leader === undefined || leader.isLead ? 'the lead' : `${whose} leader ${leader.name}`;
}

/** `the lead has an inbox line`, or for a sub-lead's member `its leader <name> has an inbox line`. */
function toldText(leader: BudgetLeader | undefined): string {
  return `${leaderText(leader, 'its')} has an inbox line`;
}

function joined(parts: readonly string[]): string {
  return parts.filter((part) => part !== '').join(' ');
}

/** The line at a new warning level. */
function levelLine(facts: BudgetFacts, budget: WarnBudget, standing: Standing): string {
  const use = `${facts.name} has used ${formatPct(facts.usedTodayPct)} of the week today; its daily budget is ${formatPct(facts.budgetPct)}${budgetMarkOf(facts.lift, facts.burst !== undefined, facts.paused)}.`;
  if (!standing.over) {
    return joined([`Budget: ${use}`, teamText(facts), MORE]);
  }
  if (!standing.held) {
    return joined([`Budget: ${use}`, roomText(facts), MORE]);
  }
  if (!standing.escalated) {
    return joined([`Budget: ${use}`, teamText(facts), `${capitalized(noRoomText(facts.teamDay))}, but the team is not ahead of its pace line, so nothing more happens.`, MORE]);
  }
  return joined([`Budget: ${use}`, `${capitalized(heldClause(facts, standing))}.`, escalatedText(facts, budget), MORE]);
}

/** The person's line as quiet hours start, their times on the team's clock. */
function quietLine(quiet: QuietHours, span: QuietSpan, facts: BudgetFacts): string {
  const helpers = facts.isLead ? undefined : helperClause(quiet.action);
  const what = helpers === undefined ? 'the team rests; start no new work.' : `${helpers}.`;
  return `Quiet hours (${facts.zone.clockSpan(new Date(span.from), new Date(span.to))}): ${what} ${MORE}`;
}

/** What the Stop hook shows and records at a turn's end. */
export interface StopWarning {
  /** Lines for the person, oldest concern first. */
  readonly lines: readonly string[];
  /** Its leader's inbox line ({@link BudgetFacts.leader}), when this turn escalated the session and the leader was not told today. */
  readonly leadLine: string | undefined;
  readonly state: WarnState;
}

/**
 * The leader's line, with the lift it can give: the lead's or a sub-lead's alike, as `budget lift` itself refuses a part
 * past the parent's budget and names the `--group` lift that would make room.
 */
function leadLineOf(facts: BudgetFacts, standing: Standing): string {
  const command = `teamrig budget lift ${facts.id} --part <pct> --stop-pct <pct> --reason "<why>"`;
  const goesOn = pastStopWork(facts, 'its');
  return (
    `${facts.name} is past its daily budget: ${formatPct(facts.usedTodayPct)} of the week today against ${formatPct(facts.budgetPct)}, ` +
    `and ${heldClause(facts, standing)}. ` +
    `${goesOn === undefined ? 'It finishes the step in hand' : `It goes on with ${goesOn.text} past the stop`}; lift it only with a stop %: ${command}.`
  );
}

/**
 * The person's lines at a turn's end: a lift or a burst starting or ending, the quiet hours starting, a new
 * warning level, or the session escalating with no new level (the team's room for the day running out, or the
 * team moving ahead of its pace line, or a leader's cut, while the session is past budget). Its leader gets one inbox
 * line a day per session once it escalates, unless the action is only `warn` or a leader's cut holds it.
 */
export function stopWarning(facts: BudgetFacts, budget: WarnBudget, previous: WarnState | undefined): StopWarning {
  const state = stateFor(previous, facts.now);
  const standing = standingOf(facts, budget);
  const lines: string[] = [];
  if (facts.lift !== undefined && facts.lift.at !== state.liftAt) {
    lines.push(liftedLine(facts.lift, facts.name, facts, facts.zone));
  } else if (facts.lift === undefined && state.liftAt !== undefined) {
    lines.push(`Budget: ${facts.name}'s lift has ended; its daily budget is ${formatPct(facts.budgetPct)} again.`);
  }
  const burst = burstStopLines(facts, state);
  lines.push(...burst.lines);
  if (budget.quietHours !== undefined && standing.quiet !== undefined && standing.quiet.from !== state.quietFrom) {
    lines.push(quietLine(budget.quietHours, standing.quiet, facts));
  }
  // A state saved before `escalated` was kept reads as not escalated: a session escalated then sees this line once more.
  if (standing.level > state.level) {
    lines.push(levelLine(facts, budget, standing));
  } else if (standing.escalated && !state.escalated) {
    lines.push(joined([`Budget: ${facts.name} is past its daily budget, and ${heldClause(facts, standing)}.`, escalatedText(facts, budget), MORE]));
  }
  const tellLead = standing.escalated && budget.overAction !== 'warn' && !facts.isLead && !state.leadTold && facts.cut === undefined;
  return {
    lines,
    leadLine: tellLead ? leadLineOf(facts, standing) : undefined,
    state: {
      day: state.day,
      level: Math.max(state.level, standing.level),
      modelLevel: state.modelLevel,
      ahead: standing.ahead,
      held: standing.held,
      escalated: standing.escalated,
      leadTold: state.leadTold || tellLead,
      quietFrom: standing.quiet?.from ?? state.quietFrom,
      liftAt: facts.lift?.at,
      burstAt: burst.burstAt,
      modelBurstAt: state.modelBurstAt,
      surplusShown: state.surplusShown,
    },
  };
}

/** What the prompt hook adds to the model's context, and records. */
export interface PromptWarning {
  readonly line: string | undefined;
  readonly state: WarnState;
}

/**
 * The model's past-budget line, once per warning level while escalated; undefined when none is due. Under `warn` it
 * only reports the overrun: the model obeys a stop sentence as an order, so saying one there held the team as `block`
 * would (T2783), while the person's line and the helper gate already hold nothing.
 */
function escalationLine(facts: BudgetFacts, budget: WarnBudget, standing: Standing, state: WarnState): string | undefined {
  if (!standing.escalated || standing.level <= state.modelLevel) {
    return undefined;
  }
  const why =
    facts.cut === undefined
      ? `the team has no room left today${standing.ahead ? ', and it is ahead of its pace line' : ''}`
      : `${leaderText(facts.cutBy, 'your')} cut you to it until ${formatEndTime(facts.cut.endsAt, facts.zone)}`;
  if (budget.overAction === 'warn') {
    return `${BUDGET_COMMAND}: you are past today's budget and ${why}. The budget only warns (budget.overAction warn), so nothing is held: go on with your task list.`;
  }
  const lift = facts.isLead ? 'As the lead, lift it only with a stop %.' : `${capitalized(leaderText(facts.leader, 'your'))} can lift it.`;
  const goesOn = pastStopWork(facts, 'your');
  const except = goesOn === undefined ? '' : `, except ${goesOn.text}: ${goesOn.plural ? 'they go' : 'it goes'} on past the daily stop`;
  return (
    `${BUDGET_COMMAND}: you are past today's budget and ${why}. Finish the step in hand and start no new work items or helpers${except}. ` +
    `Never skip a test or check to save budget. ${lift}`
  );
}

/**
 * The model's lines with a prompt, one per line: a burst starting or ending, the lead's surplus once a
 * week, and, while the session has escalated and once per warning level, finish the step in hand and
 * start nothing new. None asks for a cheaper model or effort, nor a skipped check.
 */
export function promptWarning(facts: BudgetFacts, budget: WarnBudget, previous: WarnState | undefined): PromptWarning {
  const state = stateFor(previous, facts.now);
  const standing = standingOf(facts, budget);
  const burst = burstPromptLines(facts, state);
  const escalation = escalationLine(facts, budget, standing, state);
  const lines = escalation === undefined ? burst.lines : [...burst.lines, escalation];
  if (lines.length === 0) {
    return { line: undefined, state };
  }
  return {
    line: lines.join('\n'),
    state: {
      ...state,
      modelLevel: escalation === undefined ? state.modelLevel : standing.level,
      modelBurstAt: burst.modelBurstAt,
      surplusShown: burst.surplusShown,
    },
  };
}

export type HelperGate = { readonly kind: 'allow' } | { readonly kind: 'ask' | 'deny'; readonly reason: string };

/**
 * Before a helper launch: past budget once escalated, `overAction` applies; in quiet hours,
 * `quietHours.action`; the stronger wins. Only "ask" and "block" hold a launch back. The lead's own
 * helpers, a session under its own lift and no cut, and one with p0 work or an answer another session waits on always go
 * ahead: the lead decides, a lift is a leader's decision (a cut given after it, a later one), p0 work is done right now,
 * and a held answer blocks its waiter.
 */
export function helperGate(facts: BudgetFacts, budget: WarnBudget): HelperGate {
  if (facts.isLead || (facts.lift !== undefined && facts.cut === undefined) || pastStopWork(facts, 'its') !== undefined) {
    return { kind: 'allow' };
  }
  const standing = standingOf(facts, budget);
  const reasons: { readonly action: OverAction; readonly text: string }[] = [];
  if (standing.escalated) {
    reasons.push({
      action: budget.overAction,
      text: `${facts.name} is past its daily budget (${formatPct(facts.usedTodayPct)} of the week today against ${formatPct(facts.budgetPct)}), and ${heldClause(facts, standing)}.`,
    });
  }
  const quiet = budget.quietHours;
  if (quiet !== undefined && standing.quiet !== undefined) {
    reasons.push({ action: quiet.action, text: `It is quiet hours (${facts.zone.clockSpan(new Date(standing.quiet.from), new Date(standing.quiet.to))}).` });
  }
  const strongest = Math.max(0, ...reasons.map((reason) => gateRank(reason.action)));
  if (strongest === 0) {
    return { kind: 'allow' };
  }
  const reason = `${BUDGET_COMMAND}: ${reasons.map((each) => each.text).join(' ')} ${strongest === 2 ? 'New helpers are refused' : 'New helpers ask first'}; ${leaderText(facts.leader, 'its')} can lift it. ${MORE}`;
  return { kind: strongest === 2 ? 'deny' : 'ask', reason };
}

