import { FIRST_SLICE, isGoalDay, isSlice, type Goal, type GoalSliceRecord, type Slice } from './goals.ts';

/**
 * The rules over a goal's slice records (T2203): who writes one, what a new slice names, and which slices are late.
 * A slice is a shippable part of a goal with its owner, ship day and live proof, as the lead plans the week by them;
 * goals.ts holds the record's format and fold.
 */

/** What `goal slice` asks for: the slice record's fields, each null where it keeps the slice's own. */
export type GoalSliceInput = Omit<GoalSliceRecord, 'type' | 'at' | 'by'>;

/** Who writes a slice record: the caller, and the team's lead (undefined while the role is unheld). */
export interface SliceWriter {
  readonly by: string;
  readonly lead: string | undefined;
}

/** How a slice is named in a line: its goal's tag and its number, as a task's `--prepares` names it. */
export function sliceLabel(tag: string, number: number): string {
  return `${tag}:${number}`;
}

/** True when `input` records only the evidence that a slice's proof exists, which its owner may write. */
function provesOnly(input: GoalSliceInput): boolean {
  const { title, owner, ship, proof, tasks, size, proven } = input;
  return proven !== null && title === null && owner === null && ship === null && proof === null && tasks === null && size === null;
}

/** True when every field `input` names reads so on `slice` already. */
function changesNothing(input: GoalSliceInput, slice: Slice): boolean {
  const same = <T>(value: T | null, current: T): boolean => value === null || value === current;
  const sameTasks = input.tasks === null || (input.tasks.length === slice.tasks.length && input.tasks.every((id, index) => id === slice.tasks[index]));
  return (
    input.proven === null &&
    same(input.title, slice.title) &&
    same(input.owner, slice.owner) &&
    same(input.ship, slice.ship) &&
    same(input.proof, slice.proof) &&
    same(input.size, slice.size) &&
    sameTasks
  );
}

/** Why `writer` may not write `input` on `known` (undefined: a new slice); undefined when it may. */
function writerRefusal(input: GoalSliceInput, known: Slice | undefined, writer: SliceWriter): string | undefined {
  if (writer.by === writer.lead) {
    return undefined;
  }
  if (known !== undefined && known.owner === writer.by && provesOnly(input)) {
    return undefined;
  }
  return `only the lead${writer.lead === undefined ? '' : ` (${writer.lead})`} adds and changes a goal's slices; a slice's owner records only its --proven`;
}

/** Why a slice record of the goal holding `goal.slices` may not take `tasks`: one of them makes another slice. */
function tasksRefusal(goal: Goal, number: number, tasks: readonly string[]): string | undefined {
  const others = goal.slices.filter((slice) => slice.number !== number);
  for (const id of tasks) {
    const holder = others.find((slice) => slice.tasks.includes(id));
    if (holder !== undefined) {
      return `${id} makes slice ${sliceLabel(goal.tag, holder.number)} already: a task makes one slice of a goal, so take it off that slice's --tasks first`;
    }
  }
  return new Set(tasks).size === tasks.length ? undefined : '--tasks names a task twice';
}

/** Why a slice's fields may not be what `input` names; undefined when they may. */
function fieldsRefusal(input: GoalSliceInput, known: Slice | undefined): string | undefined {
  const label = sliceLabel(input.tag, input.slice);
  if (known === undefined) {
    if (input.title === null || input.owner === null || input.ship === null || input.proof === null || input.tasks === null) {
      return `slice ${label} is new: name its --title, --owner, --ship, --proof and --tasks`;
    }
    if (input.proven !== null) {
      return `slice ${label} is new: add it first, then record --proven once its proof exists`;
    }
    return undefined;
  }
  if (input.proven !== null && known.proven !== null) {
    return `slice ${label} is proven already, by ${known.proven.by}: ${known.proven.evidence}`;
  }
  return changesNothing(input, known) ? `slice ${label} already reads so; nothing to change` : undefined;
}

/** Why `goal slice` cannot write its record over `goals` for `writer`; undefined when it can. */
export function goalSliceRefusal(input: GoalSliceInput, goals: ReadonlyMap<string, Goal>, writer: SliceWriter): string | undefined {
  const goal = goals.get(input.tag);
  if (goal === undefined) {
    return `goal ${input.tag} does not exist; add it with goal add`;
  }
  if (!isSlice(input.slice)) {
    return `a slice is a whole number from ${FIRST_SLICE}`;
  }
  if (input.note.trim() === '') {
    return 'goal slice says why in --note';
  }
  if (input.ship !== null && !isGoalDay(input.ship)) {
    return '--ship is a YYYY-MM-DD day';
  }
  const known = goal.slices.find((slice) => slice.number === input.slice);
  return writerRefusal(input, known, writer) ?? fieldsRefusal(input, known) ?? (input.tasks === null ? undefined : tasksRefusal(goal, input.slice, input.tasks));
}

/** A slice of a goal. */
export interface GoalSlice {
  readonly goal: Goal;
  readonly slice: Slice;
}

/** True when `slice` is past its ship day, `today` on the team's clock, with no proof recorded. */
export function isLate(slice: Slice, today: string): boolean {
  return slice.proven === null && slice.ship < today;
}

/** The slices past their ship day with no proof recorded, in goal and slice order. */
export function lateSlices(goals: ReadonlyMap<string, Goal>, today: string): GoalSlice[] {
  return [...goals.values()].flatMap((goal) => goal.slices.filter((slice) => isLate(slice, today)).map((slice) => ({ goal, slice })));
}

/** The goals in the order a plan reads them: ranked first, by rank, then the rest in the order they were added. */
export function goalsInRankOrder(goals: ReadonlyMap<string, Goal>): Goal[] {
  const all = [...goals.values()];
  const ranked = all.filter((goal) => goal.rank !== null).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return [...ranked, ...all.filter((goal) => goal.rank === null)];
}
