import type { JsonRecord } from '../core/guards.ts';
import { parseJsonl, type JsonlParse, type JsonlRecord } from '../core/jsonl.ts';
import { parseUtcDay } from '../core/time.ts';
import { SESSION_NAME } from './model.ts';

/**
 * Goal records (T1730): a goal's tag, title, planned window and target, each move of its target with the note saying
 * why (a slip), and its rank among the team's goals (T2083), so a goal's progress reads against a plan and goal-first
 * ranking knows which goal comes first. They live in their own
 * append-only file beside the register's `events.jsonl`, never in the event log, so a reader that knows only the
 * events never meets a line it cannot read, and a rotation never touches them. Pure: the caller hands in the text it
 * read (the pane vendors this through `read/index`).
 */

/** The goal records' file, beside the register's `events.jsonl`. */
export const GOALS_FILE = 'goals.jsonl';

/**
 * The newest format of a goal record this teamrig reads and writes: 2 added the rank record (T2083). Each record is
 * written with the oldest format that holds it, so an older teamrig still reads every goal's add and set; it counts a
 * rank record as one from a newer teamrig and refuses to write beside it, never folding the goals without their ranks.
 */
export const GOAL_RECORD_VERSION = 2;

/** The format a goal's add and set are written with: they are unchanged since format 1. */
const GOAL_ADD_SET_VERSION = 1;

/** The lowest rank, the first goal, and the highest a goal may take. */
export const FIRST_GOAL_RANK = 1;
export const MAX_GOAL_RANK = 99;

/** True for a rank a goal may take: a whole number from FIRST_GOAL_RANK to MAX_GOAL_RANK. */
export function isGoalRank(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= FIRST_GOAL_RANK && value <= MAX_GOAL_RANK;
}

/** A goal's tag: a letter, then letters, digits, `.` or `-`, at most 24 characters (`A2`, `A2.1`, `B1-a`). */
export const GOAL_TAG = /^[A-Za-z][A-Za-z0-9.-]{0,23}$/;

/** What a task names instead of a goal when it serves none; never a goal's tag. */
export const NO_GOAL = 'none';

/** A goal's first record: what it is, when its work starts and the day it is due. */
export interface GoalAdd {
  readonly type: 'goal-add';
  /** When it was written, an ISO time. */
  readonly at: string;
  readonly by: string;
  readonly tag: string;
  readonly title: string;
  /** Bare days, `YYYY-MM-DD`, of the team's clock: the planned window. */
  readonly start: string;
  readonly target: string;
  /** The goal it is part of, by tag; null for a top goal. */
  readonly parent: string | null;
}

/** A later change to a goal: a new target (a slip), a new title, or both, always with a note saying why. */
export interface GoalSet {
  readonly type: 'goal-set';
  readonly at: string;
  readonly by: string;
  readonly tag: string;
  /** The new target; null when this change keeps it. */
  readonly target: string | null;
  /** The new title; null when this change keeps it. */
  readonly title: string | null;
  readonly note: string;
}

/** A goal's rank among the team's goals (T2083): 1 goes first; null takes the goal off the ranking. */
export interface GoalRank {
  readonly type: 'goal-rank';
  readonly at: string;
  readonly by: string;
  readonly tag: string;
  readonly rank: number | null;
}

export type GoalRecord = GoalAdd | GoalSet | GoalRank;

export type GoalRecordParse =
  | { readonly kind: 'record'; readonly record: GoalRecord }
  /** Written by a newer teamrig, in a format this one does not know: counted, never guessed at. */
  | { readonly kind: 'newer' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** One move of a goal's target. */
export interface GoalSlip {
  readonly at: string;
  readonly by: string;
  readonly from: string;
  readonly to: string;
  readonly note: string;
}

/** A goal as its records fold: the latest title, target and rank, and every target move in write order. */
export interface Goal {
  readonly tag: string;
  readonly title: string;
  readonly start: string;
  readonly target: string;
  readonly parent: string | null;
  readonly addedAt: string;
  readonly addedBy: string;
  readonly slips: readonly GoalSlip[];
  /** Its latest rank, 1 first; null while it is unranked. */
  readonly rank: number | null;
}

/** The goal records as read: the goals by tag, in the order they were added, and what could not be used. */
export interface GoalsRead {
  readonly goals: ReadonlyMap<string, Goal>;
  /** Lines that are not a goal record: damaged, torn or foreign. */
  readonly unreadable: number;
  /** Records from a newer teamrig. */
  readonly newer: number;
  /** Records that fold to nothing: a change to a goal never added, or a second add of a tag. */
  readonly ignored: number;
}

export const NO_GOALS: GoalsRead = { goals: new Map(), unreadable: 0, newer: 0, ignored: 0 };

/** No goal tags: what a task may name when no goal record is read, as under `register.goals` free. */
export const NO_GOAL_TAGS: ReadonlySet<string> = new Set();

/** True for a bare `YYYY-MM-DD` that is a real calendar day. */
export function isGoalDay(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && parseUtcDay(text) !== undefined;
}

function textField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function dayField(record: JsonRecord, key: string): string | undefined {
  const value = textField(record, key);
  return value !== undefined && isGoalDay(value) ? value : undefined;
}

/** The fields every record carries, or why the record cannot be read. */
function baseOf(record: JsonRecord): { readonly at: string; readonly by: string; readonly tag: string } | string {
  const at = textField(record, 'at');
  if (at === undefined || Number.isNaN(Date.parse(at))) {
    return 'at is not a time';
  }
  const by = textField(record, 'by');
  if (by === undefined || !SESSION_NAME.test(by)) {
    return 'by is not a session';
  }
  const tag = textField(record, 'tag');
  if (tag === undefined || !GOAL_TAG.test(tag) || tag === NO_GOAL) {
    return `tag ${JSON.stringify(record['tag'])} is not a goal tag`;
  }
  return { at, by, tag };
}

/** Parses one line of the goals file. Unknown extra fields are ignored, so a later minor addition stays readable. */
export function parseGoalRecord(line: JsonlRecord): GoalRecordParse {
  if (line.version > GOAL_RECORD_VERSION) {
    return { kind: 'newer' };
  }
  const { record } = line;
  const base = baseOf(record);
  if (typeof base === 'string') {
    return { kind: 'unreadable', reason: base };
  }
  switch (record['type']) {
    case 'goal-add': {
      const title = textField(record, 'title');
      const start = dayField(record, 'start');
      const target = dayField(record, 'target');
      const parent = record['parent'] ?? null;
      if (title === undefined) {
        return { kind: 'unreadable', reason: 'title is not text' };
      }
      if (start === undefined || target === undefined) {
        return { kind: 'unreadable', reason: 'start or target is not a day' };
      }
      if (parent !== null && (typeof parent !== 'string' || !GOAL_TAG.test(parent))) {
        return { kind: 'unreadable', reason: `parent ${JSON.stringify(parent)} is not a goal tag` };
      }
      return { kind: 'record', record: { type: 'goal-add', ...base, title, start, target, parent } };
    }
    case 'goal-set': {
      const note = textField(record, 'note');
      const target = record['target'] ?? null;
      const title = record['title'] ?? null;
      if (note === undefined) {
        return { kind: 'unreadable', reason: 'note is not text' };
      }
      if (target !== null && (typeof target !== 'string' || !isGoalDay(target))) {
        return { kind: 'unreadable', reason: 'target is not a day' };
      }
      if (title !== null && (typeof title !== 'string' || title.trim() === '')) {
        return { kind: 'unreadable', reason: 'title is not text' };
      }
      return { kind: 'record', record: { type: 'goal-set', ...base, target, title, note } };
    }
    case 'goal-rank': {
      const rank = record['rank'] ?? null;
      if (rank !== null && !isGoalRank(rank)) {
        return { kind: 'unreadable', reason: `rank ${JSON.stringify(rank)} is not a whole number from ${FIRST_GOAL_RANK} to ${MAX_GOAL_RANK}` };
      }
      return { kind: 'record', record: { type: 'goal-rank', ...base, rank } };
    }
    default:
      return { kind: 'unreadable', reason: `unknown type ${JSON.stringify(record['type'])}` };
  }
}

/** A record as its line is written: the oldest format that holds it first, and a set's kept fields left out. */
export function goalRecordJson(record: GoalRecord): JsonRecord {
  switch (record.type) {
    case 'goal-add':
      return { v: GOAL_ADD_SET_VERSION, ...record };
    case 'goal-rank':
      return { v: GOAL_RECORD_VERSION, ...record };
    case 'goal-set': {
      const { target, title, ...rest } = record;
      return { v: GOAL_ADD_SET_VERSION, ...rest, ...(target === null ? {} : { target }), ...(title === null ? {} : { title }) };
    }
  }
}

/** The goal a set or a rank record leaves: a set's new title and target (a target move is a slip), a rank's rank. */
function changedGoal(goal: Goal, record: GoalSet | GoalRank): Goal {
  if (record.type === 'goal-rank') {
    return { ...goal, rank: record.rank };
  }
  const slip: GoalSlip | undefined =
    record.target !== null && record.target !== goal.target ? { at: record.at, by: record.by, from: goal.target, to: record.target, note: record.note } : undefined;
  return {
    ...goal,
    title: record.title ?? goal.title,
    target: record.target ?? goal.target,
    slips: slip === undefined ? goal.slips : [...goal.slips, slip],
  };
}

/** Folds records in write order: a set or rank changes the goal it names; one before its goal's add, or a second add, is ignored. */
export function foldGoals(records: Iterable<GoalRecord>): { readonly goals: ReadonlyMap<string, Goal>; readonly ignored: number } {
  const goals = new Map<string, Goal>();
  let ignored = 0;
  for (const record of records) {
    const goal = goals.get(record.tag);
    if (record.type === 'goal-add') {
      if (goal === undefined) {
        const { tag, title, start, target, parent, at, by } = record;
        goals.set(tag, { tag, title, start, target, parent, addedAt: at, addedBy: by, slips: [], rank: null });
      } else {
        ignored += 1;
      }
      continue;
    }
    if (goal === undefined) {
      ignored += 1;
      continue;
    }
    goals.set(record.tag, changedGoal(goal, record));
  }
  return { goals, ignored };
}

/** The goals file's text as read (undefined: no file yet), folded. A bad line is counted, never thrown. */
export function readGoals(text: string | undefined): GoalsRead {
  return text === undefined ? NO_GOALS : foldGoalLines(parseJsonl(text));
}

/** The goals file's parsed lines, folded; a writer parses once to check the versions and fold the same lines. */
export function foldGoalLines(parsed: JsonlParse): GoalsRead {
  const records: GoalRecord[] = [];
  let unreadable = parsed.unreadable;
  let newer = 0;
  for (const line of parsed.records) {
    const result = parseGoalRecord(line);
    if (result.kind === 'record') {
      records.push(result.record);
    } else if (result.kind === 'newer') {
      newer += 1;
    } else {
      unreadable += 1;
    }
  }
  const { goals, ignored } = foldGoals(records);
  return { goals, unreadable, newer, ignored };
}

/** What `goal add` asks for. */
export interface GoalAddInput {
  readonly tag: string;
  readonly title: string;
  readonly start: string;
  readonly target: string;
  readonly parent: string | null;
}

/** What `goal set` asks for: at least one of a new target and a new title, and the note. */
export interface GoalSetInput {
  readonly tag: string;
  readonly target: string | null;
  readonly title: string | null;
  readonly note: string;
}

/** What `goal rank` asks for: the goal and its new rank, null to take it off the ranking. */
export interface GoalRankInput {
  readonly tag: string;
  readonly rank: number | null;
}

/**
 * The cap on open key results (`focus.maxActiveKeyResults`, T2083): a team holds at most `max` goals with a parent
 * whose target is `today` or later, so its key results stay few enough to rank and finish.
 */
export interface KeyResultCap {
  readonly max: number;
  /** The team's day, `YYYY-MM-DD`. */
  readonly today: string;
}

/** The key results (goals with a parent) whose target is `today` or later. */
export function openKeyResults(goals: ReadonlyMap<string, Goal>, today: string): Goal[] {
  return [...goals.values()].filter((goal) => goal.parent !== null && goal.target >= today);
}

function tagRefusal(tag: string): string | undefined {
  if (tag === NO_GOAL) {
    return `"${NO_GOAL}" is what a task names when it serves no goal, never a goal's tag`;
  }
  return GOAL_TAG.test(tag) ? undefined : `"${tag}" is not a goal tag: a letter, then letters, digits, . or -, at most 24 characters`;
}

/** Why `goal add` cannot write its record over `goals`, a key result past `cap` among them; undefined when it can. */
export function goalAddRefusal(input: GoalAddInput, goals: ReadonlyMap<string, Goal>, cap: KeyResultCap): string | undefined {
  const badTag = tagRefusal(input.tag);
  if (badTag !== undefined) {
    return badTag;
  }
  if (goals.has(input.tag)) {
    return `goal ${input.tag} already exists; move its target with goal set`;
  }
  if (input.title.trim() === '') {
    return 'a goal has a title';
  }
  if (!isGoalDay(input.start) || !isGoalDay(input.target)) {
    return '--start and --target are YYYY-MM-DD days';
  }
  if (input.start > input.target) {
    return `--start ${input.start} is after --target ${input.target}`;
  }
  if (input.parent !== null && !goals.has(input.parent)) {
    return `--parent ${input.parent} is not a goal; add it first`;
  }
  return input.parent === null ? undefined : keyResultRefusal(goals, cap);
}

/** Why one more key result would pass `cap`; undefined while it would not. */
function keyResultRefusal(goals: ReadonlyMap<string, Goal>, cap: KeyResultCap): string | undefined {
  const open = openKeyResults(goals, cap.today).length;
  if (open < cap.max) {
    return undefined;
  }
  return `the team holds ${open} key results (goals with a parent) with a target of ${cap.today} or later, the most focus.maxActiveKeyResults allows: finish one or move its target first`;
}

/** Why `goal rank` cannot write its record over `goals`; undefined when it can. */
export function goalRankRefusal(input: GoalRankInput, goals: ReadonlyMap<string, Goal>): string | undefined {
  const goal = goals.get(input.tag);
  if (goal === undefined) {
    return `goal ${input.tag} does not exist; add it with goal add`;
  }
  if (input.rank !== null && !isGoalRank(input.rank)) {
    return `a rank is a whole number from ${FIRST_GOAL_RANK} to ${MAX_GOAL_RANK}, or none`;
  }
  if (input.rank === goal.rank) {
    return input.rank === null ? `goal ${input.tag} is not ranked; nothing to change` : `goal ${input.tag} already ranks ${input.rank}; nothing to change`;
  }
  return undefined;
}

/** Why `goal set` cannot write its record over `goals`; undefined when it can. */
export function goalSetRefusal(input: GoalSetInput, goals: ReadonlyMap<string, Goal>): string | undefined {
  const goal = goals.get(input.tag);
  if (goal === undefined) {
    return `goal ${input.tag} does not exist; add it with goal add`;
  }
  if (input.target === null && input.title === null) {
    return 'goal set changes --target, --title or both';
  }
  if (input.note.trim() === '') {
    return 'goal set says why in --note';
  }
  if (input.target !== null && !isGoalDay(input.target)) {
    return '--target is a YYYY-MM-DD day';
  }
  if (input.target !== null && input.target < goal.start) {
    return `--target ${input.target} is before the goal's start ${goal.start}`;
  }
  if (input.title !== null && input.title.trim() === '') {
    return 'a goal has a title';
  }
  if ((input.target ?? goal.target) === goal.target && (input.title ?? goal.title) === goal.title) {
    return `goal ${input.tag} already reads so; nothing to change`;
  }
  return undefined;
}
