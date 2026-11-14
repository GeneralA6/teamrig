import { ENV, type Env } from '../core/home.ts';
import { ID_PATTERN, NAME_PATTERN, NAME_RULE } from '../core/ids.ts';
import { parseTypedInstant, parseUtcDay, storedDeadline, typedDeadline, typedTimeHint } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import { OPTION_SEPARATOR, optionsSplitText, splitOptions, type DecisionCard } from '../register/card.ts';
import { isItemType, ITEM_TYPES, MAX_SIZE_PCT, sizeProblem, type ItemType, type TaskFields, type TaskPrep } from '../register/events.ts';
import { FIRST_SLICE, GOAL_TAG, isSlice } from '../register/goals.ts';
import { isTaskStatus, LEGACY_WAITING_HINT, LEGACY_WAITING_STATUS, priorityText, TASK_ID, TASK_STATUSES, type TaskStatus } from '../register/model.ts';
import { WAITS_USAGE, type AddInput, type AskInput, type StatusInput } from '../register/policy.ts';
import { REVIEW_FLAGS, REVIEW_ORDER, type ProblemReview } from '../register/review.ts';
import { isWaitKind, waitOf, type WaitReason } from '../register/waits.ts';
import type { ListFilter } from '../register/views.ts';
import { unrunnableReason } from '../test-run/shell.ts';
import { requiredFlag, UsageError, type Flags, type ParsedArgs } from './args.ts';

/**
 * Flag text to register inputs. Only the shape is checked here (a priority like p2, a list, a date); the
 * command resolves session names to ids against the roster, and the register's policy judges the
 * values against the team config, so each rule has one home.
 */

/** `none` clears an optional field on `update` and selects "no week plan" on `list`. */
export const NONE = 'none';

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

/**
 * A session's id or any name it has had, shape only; the command resolves it to the id against the roster.
 * Every id also has a name's shape, so one pattern covers both.
 */
export function sessionRef(flag: string, value: string): string {
  if (!NAME_PATTERN.test(value)) {
    throw new UsageError(`${flag} "${value}" is not a session id or name (${NAME_RULE})`);
  }
  return value;
}

/** The caller: `--session`, else the session variable. */
export function callerOf(flags: Flags, env: Env): string {
  const name = flags.get('session') ?? env[ENV.session]?.trim();
  if (name === undefined || name === '') {
    throw new UsageError(`--session (or $${ENV.session}) is required`);
  }
  return sessionRef('--session', name);
}

/** The command to run: the words after `--`; anything else on the line, or nothing after it, is a usage error. */
export function commandWordsOf(args: ParsedArgs): readonly string[] {
  const [stray] = args.positionals;
  if (stray !== undefined || args.rest.length === 0) {
    throw new UsageError(stray === undefined ? 'no command to run after --' : `put "${stray}" and the rest of the command after --`);
  }
  return args.rest;
}

/** The command to run in the platform's shell (`commandWordsOf`), refused when that shell would not run it as given. */
export function shellWordsOf(args: ParsedArgs, platform: NodeJS.Platform): readonly string[] {
  const words = commandWordsOf(args);
  const reason = unrunnableReason(words, platform);
  if (reason !== undefined) {
    throw new UsageError(reason);
  }
  return words;
}

/** A task as typed: its id, and the team when the id is written as a roll-up over a team tree prints it. */
export interface TaskRef {
  readonly team: string | undefined;
  readonly id: string;
}

/** `T12`, or `web/T12`: team web's task, as a roll-up over a team tree names a task of another team. */
export function taskRefOf(text: string): TaskRef {
  const parts = text.split('/');
  const [first = '', second] = parts;
  if (parts.length === 1) {
    return { team: undefined, id: taskIdOf(first) };
  }
  if (parts.length > 2 || second === undefined || !ID_PATTERN.test(first) || !TASK_ID.test(second)) {
    throw new UsageError(`"${text}" is not a task id like T12, or web/T12 for a task of team web`);
  }
  return { team: first, id: second };
}

export function taskIdOf(text: string): string {
  if (!TASK_ID.test(text)) {
    throw new UsageError(`"${text}" is not a task id like T12`);
  }
  return text;
}

/** A priority as typed: `p` and the level, 0 to 99. The policy judges it against teamrig's p0 and the team config's levels. */
const PRIORITY_TEXT = /^p(0|[1-9]\d?)$/;
/** The tier spelling, such as `t2`, that the register took before priorities. */
const OLD_TIER_TEXT = /^t([1-9]\d?)$/i;
/** A bare level, such as `2`: what `--tier` took. */
const BARE_LEVEL_TEXT = /^(0|[1-9]\d?)$/;

/** `--priority p2`: a level in the shape `p<n>`; the old `t2` and a bare `2` are refused with the spelling to use. */
export function priorityOf(text: string): number {
  const level = PRIORITY_TEXT.exec(text)?.[1];
  if (level !== undefined) {
    return Number(level);
  }
  const tier = OLD_TIER_TEXT.exec(text)?.[1];
  if (tier !== undefined) {
    throw new UsageError(`priority "${text}" is the old tier spelling: write ${priorityText(Number(tier))}`);
  }
  if (BARE_LEVEL_TEXT.test(text)) {
    throw new UsageError(`priority "${text}" is not p<n>: write ${priorityText(Number(text))}`);
  }
  throw new UsageError(`priority "${text}" is not p<n>`);
}

/** A comma list flag, its items trimmed; refused when it names none. */
export function listOf(flag: string, text: string): string[] {
  const items = text.split(',').map((item) => item.trim()).filter((item) => item !== '');
  if (items.length === 0) {
    throw new UsageError(`${flag} "${text}" is an empty list`);
  }
  return items;
}

/** What a typed time is read against: now, for a time of today, and the team's zone. */
export interface TypedTimes {
  readonly nowMs: number;
  readonly zone: TimeZone;
}

/** `--since 09:00`: a time in ms, as `parseTypedInstant` reads it. */
export function instantOf(flag: string, text: string, times: TypedTimes): number {
  const instant = parseTypedInstant(text, times.nowMs, times.zone);
  if (instant === undefined) {
    throw new UsageError(`${flag} "${text}" is not a time: ${typedTimeHint(times.zone, times.nowMs)}; YYYY-MM-DD (its start) or an ISO time with its zone`);
  }
  return instant.getTime();
}

/** `--due 2030-01-10` or `--due "2030-01-10 09:00"`: a typed deadline in its stored form (`storedDeadline`). */
export function deadlineOf(flag: string, text: string, times: TypedTimes): string {
  const stored = storedDeadline(text, times.nowMs, times.zone);
  if (stored === undefined) {
    throw new UsageError(`${flag} "${text}" is not YYYY-MM-DD or a time: ${typedTimeHint(times.zone, times.nowMs)}`);
  }
  return stored;
}

/** A size as typed: a number, a `%` after it allowed (`1.5` or `1.5%`). */
const SIZE_TEXT = /^(\d+(?:\.\d+)?|\.\d+)%?$/;

/** `--size 1.5`: what the task costs, in percent of the weekly usage limit, above 0 and at most the whole week. */
export function sizeOf(text: string): number {
  const number = SIZE_TEXT.exec(text.trim())?.[1];
  const value = number === undefined ? Number.NaN : Number(number);
  if (Number.isNaN(value) || sizeProblem(value) !== undefined) {
    throw new UsageError(`--size "${text}" is not a percent of the weekly limit above 0 and at most ${MAX_SIZE_PCT}, like 1.5`);
  }
  return value;
}

/** `--pin` (pinned by `by`) or `--unpin` on update, as a change; none with neither (T637). */
export function pinOf(switches: ReadonlySet<string>, by: string): Partial<TaskFields> {
  if (switches.has('pin') && switches.has('unpin')) {
    throw new UsageError('--pin and --unpin: give one');
  }
  return switches.has('pin') ? { pin: by } : switches.has('unpin') ? { pin: null } : {};
}

/** `--type task|bug`: what the item is (T1252); `--type task` also tells the bug hint the task is no bug. */
export function typeOf(text: string): ItemType {
  if (!isItemType(text)) {
    throw new UsageError(`--type "${text}" is not ${ITEM_TYPES.join('|')}`);
  }
  return text;
}

/** `--critical` (a bug in a critical area) or, on update, `--not-critical`, as a change; none with neither. */
export function criticalOf(switches: ReadonlySet<string>): { readonly critical?: boolean } {
  if (switches.has('critical') && switches.has('not-critical')) {
    throw new UsageError('--critical and --not-critical: give one');
  }
  return switches.has('critical') ? { critical: true } : switches.has('not-critical') ? { critical: false } : {};
}

/** `--one-commit`: the start is a one-commit fix, which the WIP rule lets through; nothing without it. */
export function oneCommitOf(switches: ReadonlySet<string>): { readonly oneCommit?: boolean } {
  return switches.has('one-commit') ? { oneCommit: true } : {};
}

/** The goals `--goals` names: its tags, or none at all, said with `none` (T1730). */
export interface GoalsSaid {
  readonly goals: readonly string[];
  /** Present, and true, only for `--goals none`. */
  readonly noGoal?: true;
}

/** `--goals A1,B2`: the goal tags the task serves; `none` alone says it serves none, and is never a tag beside others. */
export function goalsOf(text: string): GoalsSaid {
  const goals = listOf('--goals', text);
  if (!goals.includes(NONE)) {
    return { goals };
  }
  if (goals.length > 1) {
    throw new UsageError(`--goals "${text}": ${NONE} says the task serves no goal, so give it alone or give only the tags`);
  }
  return { goals: [], noGoal: true };
}

/** `--week`: a day, checked here because `check` and `plan` read it without the policy. */
export function weekOf(text: string): string {
  if (parseUtcDay(text) === undefined) {
    throw new UsageError(`--week "${text}" is not a YYYY-MM-DD date`);
  }
  return text;
}

export function addInputOf(flags: Flags, caller: string, times: TypedTimes): AddInput {
  const input: Mutable<AddInput> = {
    title: requiredFlag(flags, 'title'),
    owner: flags.get('owner') ?? caller,
    source: flags.get('source') ?? caller,
    priority: priorityOf(requiredFlag(flags, 'priority')),
  };
  const description = flags.get('description');
  if (description !== undefined) {
    input.description = description;
  }
  const ref = flags.get('ref');
  if (ref !== undefined) {
    input.ref = ref;
  }
  const due = flags.get('due');
  if (due !== undefined) {
    input.due = deadlineOf('--due', due, times);
  }
  const goals = flags.get('goals');
  if (goals !== undefined) {
    const said = goalsOf(goals);
    input.goals = said.goals;
    if (said.noGoal !== undefined) {
      input.noGoal = said.noGoal;
    }
  }
  const week = flags.get('week');
  if (week !== undefined) {
    input.week = week;
  }
  const after = flags.get('after');
  if (after !== undefined) {
    input.after = afterOf(after);
  }
  const size = flags.get('size');
  if (size !== undefined) {
    input.size = sizeOf(size);
  }
  const type = flags.get('type');
  if (type !== undefined) {
    input.type = typeOf(type);
  }
  const workClass = flags.get('class');
  if (workClass !== undefined) {
    input.workClass = workClass;
  }
  return input;
}

/** `--after T5,T6`: the tasks to finish before this one starts. */
function afterOf(text: string): string[] {
  return listOf('--after', text).map(taskIdOf);
}

/**
 * `--waits decision:owner,task:T5,time:2030-01-09 12:00`: what a waiting task waits for, each `kind:value`, the
 * value after the first colon, so a time keeps its own. Who gives a decision or an approval is resolved by the command.
 */
export function waitsOf(text: string, times: TypedTimes): WaitReason[] {
  return listOf('--waits', text).map((item) => {
    const colon = item.indexOf(':');
    const kind = item.slice(0, Math.max(colon, 0)).trim();
    if (!isWaitKind(kind)) {
      throw new UsageError(`--waits "${item}" is not one of ${WAITS_USAGE}`);
    }
    const value = item.slice(colon + 1).trim();
    const reason = waitOf(kind, kind === 'time' ? deadlineOf('--waits time:', value, times) : value);
    if (typeof reason === 'string') {
      throw new UsageError(`--waits "${item}": ${reason}`);
    }
    return reason;
  });
}

/**
 * The fields `update` changes; `none` clears the description, ref, due date, week, plan dependency or size, and
 * `--goals none` says the task serves no goal.
 */
export function changesOf(flags: Flags, times: TypedTimes): Partial<TaskFields> {
  const changes: Partial<Mutable<TaskFields>> = {};
  const title = flags.get('title');
  if (title !== undefined) {
    changes.title = title;
  }
  const description = flags.get('description');
  if (description !== undefined) {
    changes.description = description === NONE ? null : description;
  }
  const owner = flags.get('owner');
  if (owner !== undefined) {
    changes.owner = owner;
  }
  const priority = flags.get('priority');
  if (priority !== undefined) {
    changes.priority = priorityOf(priority);
  }
  const ref = flags.get('ref');
  if (ref !== undefined) {
    changes.ref = ref === NONE ? null : ref;
  }
  const due = flags.get('due');
  if (due !== undefined) {
    changes.due = due === NONE ? null : deadlineOf('--due', due, times);
  }
  const goals = flags.get('goals');
  if (goals !== undefined) {
    const said = goalsOf(goals);
    changes.goals = said.goals;
    if (said.noGoal !== undefined) {
      changes.noGoal = said.noGoal;
    }
  }
  const week = flags.get('week');
  if (week !== undefined) {
    changes.week = week === NONE ? null : week;
  }
  const after = flags.get('after');
  if (after !== undefined) {
    changes.after = after === NONE ? [] : afterOf(after);
  }
  const size = flags.get('size');
  if (size !== undefined) {
    changes.size = size === NONE ? null : sizeOf(size);
  }
  const type = flags.get('type');
  if (type !== undefined) {
    changes.type = typeOf(type);
  }
  const workClass = flags.get('class');
  if (workClass !== undefined) {
    changes.workClass = workClass === NONE ? null : workClass;
  }
  const prepares = flags.get('prepares');
  if (prepares !== undefined) {
    changes.prepares = prepares === NONE ? null : prepOf(prepares);
  }
  return changes;
}

/** `--prepares G:2`: the goal and its slice the task prepares (T2453); the policy checks the goal is a record. */
export function prepOf(text: string): TaskPrep {
  const colon = text.lastIndexOf(':');
  const goal = text.slice(0, Math.max(colon, 0));
  const sliceText = text.slice(colon + 1);
  const slice = /^\d+$/.test(sliceText) ? Number(sliceText) : Number.NaN;
  if (colon < 0 || !GOAL_TAG.test(goal) || !isSlice(slice)) {
    throw new UsageError(`--prepares "${text}" is not <goal>:<slice> like G1:2 (a slice from ${FIRST_SLICE}) or ${NONE}`);
  }
  return { goal, slice };
}

/** A status as typed; `next` says what to type for the old `blocked`, which is refused (no alias kept). */
function statusOf(flag: string, text: string, next: string): TaskStatus {
  if (text === LEGACY_WAITING_STATUS) {
    throw new UsageError(`${flag} ${LEGACY_WAITING_HINT}: ${next}`);
  }
  if (!isTaskStatus(text)) {
    throw new UsageError(`${flag} "${text}" is not ${TASK_STATUSES.join('|')}`);
  }
  return text;
}

export function statusInputOf(flags: Flags, times: TypedTimes): StatusInput {
  const input: Mutable<StatusInput> = {
    status: statusOf('--status', requiredFlag(flags, 'status'), `use --status waiting --waits <reason> (${WAITS_USAGE})`),
  };
  const note = flags.get('note');
  if (note !== undefined) {
    input.note = note;
  }
  const evidence = flags.get('evidence');
  if (evidence !== undefined) {
    input.evidence = evidence;
  }
  const skill = flags.get('skill');
  if (skill !== undefined) {
    input.skill = skill;
  }
  const waits = flags.get('waits');
  if (waits !== undefined) {
    input.waits = waitsOf(waits, times);
  }
  const card = cardInputOf(flags);
  if (card !== undefined) {
    input.card = card;
  }
  const proof = flags.get('proof');
  if (proof !== undefined) {
    input.proof = proof;
  }
  const watch = flags.get('watch');
  if (watch !== undefined) {
    input.watch = watch;
  }
  const met = flags.get('met');
  if (met !== undefined) {
    input.met = met;
  }
  const due = flags.get('due');
  if (due !== undefined) {
    input.due = deadlineOf('--due', due, times);
  }
  const followups = flags.get('followups');
  if (followups !== undefined) {
    input.followups = followups === NONE ? [] : listOf('--followups', followups).map(taskIdOf);
  }
  const review = reviewInputOf(flags);
  if (review !== undefined) {
    input.review = review;
  }
  return input;
}

/** The review parts a `set` gives (`--cause`, `--how`, `--prevent`, `--harden`, `--missed-*`); undefined when it gives none. */
function reviewInputOf(flags: Flags): ProblemReview | undefined {
  const review: Mutable<ProblemReview> = {};
  for (const part of REVIEW_ORDER) {
    const text = flagText(flags, REVIEW_FLAGS[part].slice(2));
    if (text !== undefined) {
      review[part] = text;
    }
  }
  return Object.keys(review).length === 0 ? undefined : review;
}

/** The card parts a `set` names (`--question`, `--options`, `--recommend`, `--default`, `--why-ask`, `--gate`, `--affects`); undefined when it names none. */
function cardInputOf(flags: Flags): Partial<DecisionCard> | undefined {
  const card: Mutable<Partial<DecisionCard>> = {};
  const question = flagText(flags, 'question');
  if (question !== undefined) {
    card.question = question;
  }
  const options = flags.get('options');
  if (options !== undefined) {
    card.options = optionsOf(options);
  }
  const recommend = flagText(flags, 'recommend');
  if (recommend !== undefined) {
    card.recommend = recommend;
  }
  const byDefault = flagText(flags, 'default');
  if (byDefault !== undefined) {
    card.byDefault = byDefault;
  }
  const whyAsk = flagText(flags, 'why-ask');
  if (whyAsk !== undefined) {
    card.whyAsk = whyAsk;
  }
  const gate = flagText(flags, 'gate');
  if (gate !== undefined) {
    card.gate = gate;
  }
  const affects = flagText(flags, 'affects');
  if (affects !== undefined) {
    card.affects = affects;
  }
  return Object.keys(card).length === 0 ? undefined : card;
}

/** A text flag as typed, trimmed, such as a card or review part; a blank one is a usage error. */
function flagText(flags: Flags, name: string): string | undefined {
  const text = flags.get(name)?.trim();
  if (text === '') {
    throw new UsageError(`--${name} needs text`);
  }
  return text;
}

/** `--options "<a> | <b>"`: the choices, each trimmed, a `\\|` kept as a literal `|`; an empty one is a usage error. */
function optionsOf(text: string): string[] {
  const options = splitOptions(text);
  if (options.some((option) => option === '')) {
    throw new UsageError(`--options has an empty choice: separate the choices with ${OPTION_SEPARATOR}; ${optionsSplitText(options)}`);
  }
  return options;
}

/** What `set` writes: the status change and, with `--ask`, the task it asks another session for. */
export interface SetInput {
  readonly status: StatusInput;
  readonly ask: AskInput | null;
}

/**
 * `set <id> --status ... [--ask <session> --text "<the work>"]`: with `--ask`, `--due` is the asked task's due date
 * rather than a date to verify by; `--text` goes only with `--ask`, which needs it. The command resolves the asked
 * session to its id.
 */
export function setInputOf(flags: Flags, times: TypedTimes): SetInput {
  const asked = flags.get('ask');
  const text = flags.get('text');
  if (asked === undefined) {
    if (text !== undefined) {
      throw new UsageError('--text goes only with --ask <session>: it is the work asked for');
    }
    return { status: statusInputOf(flags, times), ask: null };
  }
  if (text === undefined || text.trim() === '') {
    throw new UsageError('--ask needs --text "<the work asked for>": the title of the task it creates');
  }
  const { due, ...status } = statusInputOf(flags, times);
  return { status, ask: { owner: sessionRef('--ask', asked), title: text, ...(due === undefined ? {} : { due }) } };
}

/** `list` filters; `--session` names the owner whose tasks to show. */
export function listFilterOf(flags: Flags, times: TypedTimes): ListFilter {
  const filter: Mutable<ListFilter> = {};
  const owner = flags.get('session');
  if (owner !== undefined) {
    filter.owner = sessionRef('--session', owner);
  }
  const status = flags.get('status');
  if (status !== undefined) {
    filter.statuses = status === 'all' ? TASK_STATUSES : listOf('--status', status).map((item) => statusOf('--status', item, 'use --status waiting'));
  }
  const source = flags.get('source');
  if (source !== undefined) {
    filter.source = source;
  }
  const priorities = flags.get('priority');
  if (priorities !== undefined) {
    filter.priorities = listOf('--priority', priorities).map(priorityOf);
  }
  const dueBefore = flags.get('due-before');
  if (dueBefore !== undefined) {
    const at = typedDeadline(dueBefore, times.nowMs, times.zone);
    if (at === undefined) {
      throw new UsageError(`--due-before "${dueBefore}" is not YYYY-MM-DD or a time: ${typedTimeHint(times.zone, times.nowMs)}`);
    }
    filter.dueBefore = at;
  }
  const week = flags.get('week');
  if (week !== undefined) {
    filter.week = week === NONE ? null : weekOf(week);
  }
  const goal = flags.get('goal');
  if (goal !== undefined) {
    filter.goal = goal;
  }
  const types = flags.get('type');
  if (types !== undefined) {
    filter.types = listOf('--type', types).map(typeOf);
  }
  return filter;
}
