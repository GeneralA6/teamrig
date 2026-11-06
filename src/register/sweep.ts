import type { FocusConfig } from '../config/types.ts';
import { isRecord } from '../core/guards.ts';
import { MS_PER_DAY } from '../core/time.ts';
import type { Task } from './fold.ts';
import { ACTIVE_STATUSES } from './model.ts';
import type { Verdict } from './policy.ts';

/**
 * The goal-first sweep (T2076 part 1D): what class, objective and size each active task should take, proposed from what
 * the register already holds, and which of those proposals a person confirmed. Nothing here writes: the command reads
 * the tasks and goals, a person edits the rows, and only a row marked `yes` becomes a register update. Pure, so the
 * rules and the apply diff are held by tests without a register.
 */

export const SWEEP_CONFIDENCES = ['high', 'medium', 'low'] as const;

export type SweepConfidence = (typeof SWEEP_CONFIDENCES)[number];

/** The `confirm` of a row a person accepted; any other value leaves the row. */
export const SWEEP_CONFIRMED = 'yes';

/** One proposal, as a line of the sweep file. The names are the file's, so `class` stays spelled as a person reads it. */
export interface SweepRow {
  readonly id: string;
  readonly team: string;
  readonly owner: string;
  readonly class: string;
  /** The goal tag the task serves; null: none proposed, so its goals stay as they are. */
  readonly objective: string | null;
  /** Percent of the week; null: a person cleared it, so its size stays as it is. */
  readonly size: number | null;
  readonly reason: string;
  readonly confidence: SweepConfidence;
  readonly park: boolean;
  readonly confirm: string;
}

/** What the sweep reads of a goal. */
export interface SweepGoal {
  readonly tag: string;
  readonly title: string;
  readonly parent: string | null;
  readonly rank: number | null;
}

/** The part of the `focus` config the sweep reads. A team may rename its classes, so none is spelled here. */
export type SweepFocus = Pick<FocusConfig, 'roadmapClass' | 'maintenanceClass' | 'defaultClass' | 'parkAfterDays'>;

/** What the sweep reads of a task. */
export type SweepTask = Pick<Task, 'id' | 'title' | 'owner' | 'goals' | 'type' | 'critical' | 'status' | 'pin' | 'source' | 'updatedAt' | 'workClass'>;

/** What a row is proposed from, beside the task. */
export interface SweepInput {
  readonly team: string;
  readonly focus: SweepFocus;
  /** The goals the task may name, by tag: its team's and those of the teams above. */
  readonly goals: ReadonlyMap<string, SweepGoal>;
  /** The source that marks the human owner (`register.ownerSource`). */
  readonly ownerSource: string;
  readonly now: number;
  /** The task's size in percent of the week, from the same chain the score reads. */
  readonly sizeOf: (task: SweepTask) => number;
  /** True when an active task needs this one, by `after` or a task wait. */
  readonly needed: (id: string) => boolean;
}

/** The title words that mark upkeep rather than planned work; `data loss` matches as two words in a row. */
const MAINTENANCE_WORDS = ['incident', 'outage', 'security', 'exposure', 'leak', 'data loss', 'backup', 'restore'] as const;

const MAINTENANCE_TITLE = new RegExp(`\\b(${MAINTENANCE_WORDS.join('|')})s?\\b`, 'i');

/** Words too common in task and goal titles to say the two are about the same thing. */
const STOP_WORDS: ReadonlySet<string> = new Set(['about', 'after', 'each', 'every', 'from', 'goal', 'have', 'into', 'more', 'over', 'task', 'tasks', 'that', 'their', 'them', 'then', 'this', 'when', 'with']);

/** The shortest word that counts toward a title match. */
const MIN_TITLE_WORD = 4;

/** How many words a title shares with a goal's for a match: one shared word is usually chance. */
const MIN_SHARED_WORDS = 2;

/** The words of a title that can match, lower case, each once. */
export function titleWords(title: string): ReadonlySet<string> {
  const words = title.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return new Set(words.filter((word) => word.length >= MIN_TITLE_WORD && !STOP_WORDS.has(word)));
}

/** The goal up a chain from `tag`, itself first. A chain is walked once, so a damaged file's loop cannot hang it. */
function chainOf(tag: string, goals: ReadonlyMap<string, SweepGoal>): SweepGoal[] {
  const chain: SweepGoal[] = [];
  const walked = new Set<string>();
  for (let at: string | null = tag; at !== null && !walked.has(at); ) {
    walked.add(at);
    const goal = goals.get(at);
    if (goal === undefined) {
      break;
    }
    chain.push(goal);
    at = goal.parent;
  }
  return chain;
}

/** The ranked goals among `goals`, the best (lowest) rank first; a tie keeps the order given. */
function rankedFirst(goals: readonly SweepGoal[]): SweepGoal[] {
  return goals.filter((goal) => goal.rank !== null).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
}

/** The best ranked goal among a task's goals and their ancestors, as `rankOf` reads it, for the tag it names. */
function bestGoalOf(task: Pick<SweepTask, 'goals'>, goals: ReadonlyMap<string, SweepGoal>): SweepGoal | undefined {
  return rankedFirst(task.goals.flatMap((tag) => chainOf(tag, goals))).at(0);
}

/** The ranked goal a title shares the most words with, the better rank first; undefined when none reaches the bar. */
function titleMatchOf(title: string, goals: ReadonlyMap<string, SweepGoal>): { readonly goal: SweepGoal; readonly shared: readonly string[] } | undefined {
  const words = titleWords(title);
  let best: { readonly goal: SweepGoal; readonly shared: readonly string[] } | undefined;
  for (const goal of rankedFirst([...goals.values()])) {
    const shared = [...titleWords(goal.title)].filter((word) => words.has(word));
    if (shared.length >= MIN_SHARED_WORDS && shared.length > (best?.shared.length ?? 0)) {
      best = { goal, shared };
    }
  }
  return best;
}

/** Why a task reads as upkeep; undefined when it does not. */
function maintenanceReason(task: Pick<SweepTask, 'title' | 'type' | 'critical'>): string | undefined {
  if (task.critical) {
    return 'marked critical';
  }
  if (task.type === 'bug') {
    return 'a bug';
  }
  const word = MAINTENANCE_TITLE.exec(task.title)?.[1];
  return word === undefined ? undefined : `title says ${word.toLowerCase()}`;
}

type Proposal = Pick<SweepRow, 'class' | 'objective' | 'reason' | 'confidence'>;

/** The class, objective, reason and confidence the rules give a task, the first rule that holds deciding. */
export function proposalOf(task: SweepTask, input: Pick<SweepInput, 'focus' | 'goals'>): Proposal {
  const { focus, goals } = input;
  const best = bestGoalOf(task, goals);
  if (task.workClass !== null) {
    // A class already stored was a person's call, or a row they confirmed: a later sweep never argues with it.
    return { class: task.workClass, objective: best?.tag ?? null, reason: 'class already set', confidence: 'high' };
  }
  if (best !== undefined) {
    return { class: focus.roadmapClass, objective: best.tag, reason: `serves ranked goal ${best.tag} (#${String(best.rank)})`, confidence: 'high' };
  }
  const upkeep = maintenanceReason(task);
  if (upkeep !== undefined) {
    return { class: focus.maintenanceClass, objective: null, reason: upkeep, confidence: task.critical ? 'high' : 'medium' };
  }
  const match = titleMatchOf(task.title, goals);
  if (match !== undefined) {
    return { class: focus.roadmapClass, objective: match.goal.tag, reason: `title shares ${match.shared.join(', ')} with goal ${match.goal.tag}`, confidence: 'low' };
  }
  return { class: focus.defaultClass, objective: null, reason: 'no ranked goal, no upkeep sign', confidence: 'medium' };
}

/**
 * Whether phase 2 would park the task, the rule of design section 6 (2C): only a STORED class counts, so a task no one
 * classed never parks, and nothing parks until confirmed rows land. A waiting or verifying task stays out, as parking
 * one would lose its READY and its proof date.
 */
export function wouldPark(task: SweepTask, input: Pick<SweepInput, 'focus' | 'ownerSource' | 'now' | 'needed'>): boolean {
  const { focus } = input;
  const stored = task.workClass;
  if (stored === null || stored === focus.roadmapClass || stored === focus.maintenanceClass) {
    return false;
  }
  const quietFor = input.now - Date.parse(task.updatedAt);
  return (
    task.status === 'open' &&
    quietFor >= focus.parkAfterDays * MS_PER_DAY &&
    task.pin === null &&
    !task.critical &&
    task.source !== input.ownerSource &&
    !input.needed(task.id)
  );
}

/** The proposal for one active task, its `confirm` left empty for a person. */
export function proposeRow(task: SweepTask, input: SweepInput): SweepRow {
  const proposal = proposalOf(task, input);
  return {
    id: task.id,
    team: input.team,
    owner: task.owner,
    class: proposal.class,
    objective: proposal.objective,
    size: Number(input.sizeOf(task).toFixed(2)),
    reason: proposal.reason,
    confidence: proposal.confidence,
    park: wouldPark(task, input),
    confirm: '',
  };
}

/** How many rows each team holds of each class, teams and classes by name. */
export function sweepCounts(rows: readonly Pick<SweepRow, 'team' | 'class'>[]): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const teams = new Map<string, Map<string, number>>();
  for (const row of [...rows].sort((a, b) => a.team.localeCompare(b.team) || a.class.localeCompare(b.class))) {
    const classes = teams.get(row.team) ?? new Map<string, number>();
    classes.set(row.class, (classes.get(row.class) ?? 0) + 1);
    teams.set(row.team, classes);
  }
  return teams;
}

const TASK_ID = /^T\d+$/;

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isConfidence(value: unknown): value is SweepConfidence {
  return SWEEP_CONFIDENCES.some((confidence) => confidence === value);
}

/** A size a person may leave: none, or a share of the week above 0, at most 100, as `--size` takes it. */
function isRowSize(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && value > 0 && value <= 100);
}

export function isSweepRow(value: unknown): value is SweepRow {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    TASK_ID.test(value['id']) &&
    isText(value['team']) &&
    isText(value['owner']) &&
    isText(value['class']) &&
    (value['objective'] === null || isText(value['objective'])) &&
    isRowSize(value['size']) &&
    typeof value['reason'] === 'string' &&
    isConfidence(value['confidence']) &&
    typeof value['park'] === 'boolean' &&
    typeof value['confirm'] === 'string'
  );
}

/** The shape of a sweep file's line, named in a refusal. */
export const SWEEP_ROW_SHAPE =
  '{"id": "T<n>", "team": "<team>", "owner": "<session>", "class": "<class>", "objective": "<tag>"|null, "size": <pct>|null, "reason": "..", "confidence": "high|medium|low", "park": false, "confirm": ""}';

/** The JSONL text of the rows, one line each. */
export function formatSweepRows(rows: readonly SweepRow[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join('');
}

/**
 * The rows of a sweep file. Refused whole on a line that is no row or a task named twice: a person edited this file, so
 * a damaged line may be the one they meant to confirm, and writing the rest would leave them guessing what landed.
 */
export function parseSweepFile(text: string): Verdict<readonly SweepRow[]> {
  const rows: SweepRow[] = [];
  const seen = new Set<string>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '') {
      continue;
    }
    const at = `line ${index + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return { ok: false, error: `${at} is not JSON: ${SWEEP_ROW_SHAPE}` };
    }
    if (!isSweepRow(raw)) {
      return { ok: false, error: `${at} is not a sweep row: ${SWEEP_ROW_SHAPE}` };
    }
    const key = `${raw.team}/${raw.id}`;
    if (seen.has(key)) {
      return { ok: false, error: `${at} repeats ${key}: give each task one row` };
    }
    seen.add(key);
    rows.push(raw);
  }
  return { ok: true, value: rows };
}

/** What a confirmed row changes on its task: only the fields it holds a new value for. */
export interface SweepChanges {
  readonly workClass?: string;
  readonly goals?: readonly string[];
  readonly size?: number;
}

/** What the apply reads of a task. */
export type SweepTarget = Pick<SweepTask, 'workClass' | 'goals' | 'status'> & Pick<Task, 'size'>;

/** The fields of `task` a row would change. A goal the task already serves through a key result needs no new tag. */
export function changesOf(row: SweepRow, task: SweepTarget, goals: ReadonlyMap<string, SweepGoal>): SweepChanges {
  const { objective, size } = row;
  const served = objective === null || task.goals.some((tag) => tag === objective || chainOf(tag, goals).some((goal) => goal.tag === objective));
  return {
    ...(row.class === task.workClass ? {} : { workClass: row.class }),
    ...(served ? {} : { goals: [...task.goals, objective] }),
    ...(size === null || size === task.size ? {} : { size }),
  };
}

/** What becomes of one row: `change` when it holds something new and the caller may write it, any other row is left. */
export type SweepPlan =
  | { readonly row: SweepRow; readonly action: 'change'; readonly changes: SweepChanges }
  | { readonly row: SweepRow; readonly action: 'unchanged' }
  | { readonly row: SweepRow; readonly action: 'unconfirmed' }
  | { readonly row: SweepRow; readonly action: 'refused'; readonly reason: string };

/** Why the caller may not write `changes` on the task; undefined when it may. The register's own policy answers. */
export type SweepJudge = (changes: SweepChanges) => string | undefined;

/**
 * The fate of one row. `task` is undefined when the register lacks it. A finished task is refused, not skipped: a
 * person said yes to it, so they hear why it did not land.
 */
export function planSweepRow(row: SweepRow, task: SweepTarget | undefined, goals: ReadonlyMap<string, SweepGoal>, judge: SweepJudge): SweepPlan {
  if (row.confirm !== SWEEP_CONFIRMED) {
    return { row, action: 'unconfirmed' };
  }
  if (task === undefined) {
    return { row, action: 'refused', reason: `no task ${row.id} in team ${row.team}` };
  }
  if (!ACTIVE_STATUSES.includes(task.status)) {
    return { row, action: 'refused', reason: `${row.id} is ${task.status} now` };
  }
  const changes = changesOf(row, task, goals);
  if (Object.keys(changes).length === 0) {
    return { row, action: 'unchanged' };
  }
  const reason = judge(changes);
  return reason === undefined ? { row, action: 'change', changes } : { row, action: 'refused', reason };
}

/** The counts an apply prints: a sweep only ever updates, so `inserted` is always 0. */
export interface SweepTally {
  readonly inserted: 0;
  readonly changed: number;
  readonly unchanged: number;
  readonly unconfirmed: number;
  readonly refused: number;
}

export function tallyOf(plans: readonly SweepPlan[]): SweepTally {
  const count = (action: SweepPlan['action']) => plans.filter((plan) => plan.action === action).length;
  return { inserted: 0, changed: count('change'), unchanged: count('unchanged'), unconfirmed: count('unconfirmed'), refused: count('refused') };
}

/** One line naming what a change writes, for the dry run and the write alike. */
export function changesText(changes: SweepChanges): string {
  const parts = [
    ...(changes.workClass === undefined ? [] : [`class ${changes.workClass}`]),
    ...(changes.goals === undefined ? [] : [`goals ${changes.goals.join(',')}`]),
    ...(changes.size === undefined ? [] : [`size ${String(changes.size)}`]),
  ];
  return parts.join(', ');
}
