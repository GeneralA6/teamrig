import { parseDeadline, showStored, storedText } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import { cardLines } from './card.ts';
import type { ItemType, RegisterEvent } from './events.ts';
import { itemTypeOf } from './item-types.ts';
import type { ApprovalAnswer, Task } from './fold.ts';
import { ACTIVE_STATUSES, GITHUB_SOURCE, priorityText, type TaskStatus } from './model.ts';
import { reviewLines, reviewPartNames } from './review.ts';
import { decidingKey, planOrder, type RankedPlace, type TaskTree, type Unblocks, type WaitingOnYou } from './tree.ts';
import { waitsText, weekdayText, type PersonWait } from './waits.ts';
import { proofOf, proofText, type WatchedTask } from './verify.ts';

export interface ListFilter {
  readonly owner?: string;
  /** Default: the active statuses. */
  readonly statuses?: readonly TaskStatus[];
  readonly source?: string;
  readonly priorities?: readonly number[];
  /** Due strictly before this instant; undated tasks never match. */
  readonly dueBefore?: Date;
  /** A week plan's start day; null selects tasks in no week plan. */
  readonly week?: string | null;
  readonly goal?: string;
  /** The item types to show; a task with no type counts as a task. */
  readonly types?: readonly ItemType[];
}

/** A size as printed: percent of the weekly limit, at most two decimals (`1.5%`). */
export function sizeText(size: number): string {
  return `${Number(size.toFixed(2))}%`;
}

/** The fields plan order reads, so a reader can sort its own rows that carry them. */
export type PlanOrdered = Pick<Task, 'id' | 'due'>;

/**
 * The task's own deadline in ms, a stored day read as a day of the team's `zone`; undefined when it has none.
 * {@link TaskTree.dueTime} gives the effective one.
 */
export function dueTime(task: Pick<Task, 'due'>, zone: TimeZone): number | undefined {
  return task.due === null ? undefined : parseDeadline(task.due, zone)?.getTime();
}

/**
 * Plan order on the tasks' own due dates: due date (undated last), then id; with no tree there is no band or score to
 * read. For rows no effective due reaches (finished tasks) and readers with no tree; {@link TaskTree.byPlanOrder} orders
 * active work.
 */
export function byPlanOrder(a: PlanOrdered, b: PlanOrdered, zone: TimeZone): number {
  return planOrder({ id: a.id, at: dueTime(a, zone) }, { id: b.id, at: dueTime(b, zone) });
}

/** The tasks that match the filter in plan order; `dueBefore` and the order read the effective due of `tree`. */
export function selectTasks(tasks: Iterable<Task>, filter: ListFilter, tree: TaskTree): Task[] {
  const statuses = filter.statuses ?? ACTIVE_STATUSES;
  const dueBefore = filter.dueBefore?.getTime();
  return [...tasks]
    .filter((task) => {
      const due = tree.dueTime(task);
      return (
        statuses.includes(task.status) &&
        (filter.owner === undefined || task.owner === filter.owner) &&
        (filter.source === undefined || task.source === filter.source) &&
        (filter.priorities === undefined || filter.priorities.includes(task.priority)) &&
        (dueBefore === undefined || (due !== undefined && due < dueBefore)) &&
        (filter.week === undefined || task.week === filter.week) &&
        (filter.goal === undefined || task.goals.includes(filter.goal)) &&
        (filter.types === undefined || filter.types.includes(itemTypeOf(task)))
      );
    })
    .sort((a, b) => tree.byPlanOrder(a, b));
}

/** The task's id, or `<team>/<id>` when a roll-up over a tree of teams names its team. */
export function taskLabel(task: Task, team?: string): string {
  return team === undefined ? task.id : `${team}/${task.id}`;
}

/**
 * The fields every task row starts with: `T12 in-progress`, its class and score when `tree` ranks (`Roadmap, score
 * 21.3`), `p2`, its type past a plain task (`bug`, `critical bug`), `owner alpha`, then `due 01-15` and `after T5,T6`
 * (its plan dependency) when it has them. The due is the effective one of `tree`, in its zone: an earlier due of a task
 * that needs it names that task (`due 01-10 (from T194)`).
 */
function rowHead(task: Task, team: string | undefined, tree: TaskTree): string[] {
  const type = itemTypeOf(task);
  const typed = type === 'task' ? [] : [task.critical ? `critical ${type}` : type];
  const pinned = task.pin === null ? [] : ['pinned'];
  const ranked = tree.rankedOf(task);
  const scored = ranked === undefined ? [] : [ranked.workClass, `score ${ranked.score}`];
  const parts = [`${taskLabel(task, team)} ${task.status}`, ...scored, priorityText(task.priority), ...pinned, ...typed, `owner ${task.owner}`];
  const inherited = tree.effectiveDue(task.id);
  if (inherited !== undefined && inherited.from !== null) {
    parts.push(`due ${showStored(inherited.due, tree.zone)} (from ${inherited.from})`);
  } else if (task.due !== null) {
    parts.push(`due ${showStored(task.due, tree.zone)}`);
  }
  if (task.after.length > 0) {
    parts.push(`after ${task.after.join(',')}`);
  }
  return parts;
}

/** How long a proof runs in the verify queue's rows before it is cut. */
const SUMMARY_PROOF_CHARS = 60;
/** The most verifying tasks the verify queue names; a `+N more` line names the command that lists them all. */
export const SUMMARY_VERIFY_ROWS = 5;

/**
 * `VERIFY 2, oldest first:` and a row each, `  T1 (proof: ...)`, each proof cut short, at most SUMMARY_VERIFY_ROWS
 * rows and a `+N more` line naming `<command> verify --session <owner>`, which lists the whole queue, then one
 * `WATCH <n> done, ...` line for the done tasks still `watched` for a sighting; undefined when both are empty.
 */
export function formatVerifySummary(queue: readonly Task[], watched: readonly Task[], owner: string, command: string): string | undefined {
  const listed = `\`${command} verify --session ${owner}\``;
  const watch = watched.length > 0 ? [`WATCH ${watched.length} done, waiting on a sighting: ${listed}`] : [];
  if (queue.length === 0) {
    return watch.length === 0 ? undefined : watch.join('\n');
  }
  const rows = queue.slice(0, SUMMARY_VERIFY_ROWS).map((task) => `  ${task.id} (proof: ${cut(proofText(task), SUMMARY_PROOF_CHARS)})`);
  const left = queue.length - rows.length;
  const more = left > 0 ? [`  +${left} more: ${listed}`] : [];
  return [`VERIFY ${queue.length}, oldest first:`, ...rows, ...more, ...watch].join('\n');
}

/** formatVerifySummary's one line when a start note has no room for its rows (T1376): the command that lists them. */
export function verifySummaryPointer(owner: string, command: string): string {
  return `VERIFY: this start has no room for your verifying and watched tasks; \`${command} verify --session ${owner}\` lists them.`;
}

/** A row of `verify`, times in the team's `zone`: `T1 since 01-07 12:00 IST, verify by 01-09 | <title> (proof: ...)`. */
export function formatVerifyRow(task: Task, zone: TimeZone): string {
  const by = task.due === null ? 'no verify-by date' : `verify by ${showStored(task.due, zone)}`;
  return `${task.id} since ${zone.shortMinute(new Date(task.statusAt))}, ${by} | ${task.title} (proof: ${proofText(task)})`;
}

/** A watched row of `verify`, its time in the team's `zone`: `T1 done 01-07 12:00 IST | <title> (watch: ...)`. */
export function formatWatchRow(task: WatchedTask, zone: TimeZone): string {
  return `${task.id} done ${zone.shortMinute(new Date(task.statusAt))} | ${task.title} (watch: ${task.watch})`;
}

/** The Stop hook's line once a verifying task's verify-by day has come, its time in the team's `zone`. */
export function formatVerifyByLine(task: Task, zone: TimeZone): string {
  return `VERIFY ${task.id} was to be verified by ${showStored(task.due ?? '', zone)} (proof: ${proofText(task)}): done with the proof, or back to in-progress`;
}

/** `text` cut to `max` characters, counted in code points so a character is never split, ending in `…` when cut. */
export function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/**
 * The short row of `list` and `check`: `T12 in-progress, p2, owner alpha, due 01-15 | <title cut to titleChars>`,
 * what a waiting task waits for: `(waiting: decision owner · on T5 ready)`, and which task of another session needs
 * it (`· needed by T194 (beta, due 01-10) +1`). It keeps what orders and assigns the work, and the issue of a task
 * imported from GitHub (`from gh:acme/web#7`) so it can be found there; it leaves the week, other sources, goals and
 * status note to `show`. `tree` gives the effective due, the ready reasons, the tasks that need it and the zone
 * times show in.
 */
export function formatShortTask(task: Task, titleChars: number, team: string | undefined, tree: TaskTree): string {
  return `${shortRow(task, titleChars, team, tree)}${neededByText(task, tree)}`;
}

/** {@link formatShortTask} without what needs the task: a node of the tree and the start of a waiting-on-you row. */
function shortRow(task: Task, titleChars: number, team: string | undefined, tree: TaskTree): string {
  const waits = task.waits.length > 0 || task.decided !== null ? ` (waiting: ${waitingText(task, tree)})` : '';
  const issue = issueOf(task);
  const head = issue === undefined ? rowHead(task, team, tree) : [...rowHead(task, team, tree), `from ${issue}`];
  return `${head.join(', ')} | ${cut(task.title, titleChars)}${waits}`;
}

/**
 * ` · needed by T194 (beta, due 01-10) +1`: the active tasks of other sessions that need an active task, the first
 * the one with the earliest effective due, then in plan order. The due is left out when the row already shows it as
 * `(from T194)`. Empty for a finished task, or when only its owner's own tasks need it.
 */
function neededByText(task: Task, tree: TaskTree): string {
  const [first, ...rest] = tree.neededByOthers(task.id);
  if (first === undefined) {
    return '';
  }
  const due = tree.effectiveDue(first.id);
  const shown = due !== undefined && tree.effectiveDue(task.id)?.from === (due.from ?? first.id);
  const facts = due === undefined || shown ? [first.owner] : [first.owner, `due ${showStored(due.due, tree.zone)}`];
  return ` · needed by ${first.id} (${facts.join(', ')})${rest.length > 0 ? ` +${rest.length}` : ''}`;
}

/** A task and the tree of its register, which places it in plan order ({@link TaskTree.placeOf}). */
export interface PlacedRow {
  readonly task: Task;
  readonly tree: TaskTree;
}

/**
 * Why `row` sorts ahead of `next`, the row after it, in plan order: the first plan key on which they differ, in words:
 * `expedite`, `score 21.3 (A1 #1)` (its score, and the ranked goal it serves), `in progress`, `due` (the row shows the
 * date), `unblocks T566 p1 +2` (the best task that needs it, its priority and how many more), `in week 01-07`,
 * `size 0.5%`. Undefined when the row shows it already (pinned, or a band the row's class names), when only the number
 * decides (age, the older first), when they tie, or when `next` sorts ahead. Each row is placed by its own register's
 * tree.
 */
export function aheadReason(row: PlacedRow, next: PlacedRow): string | undefined {
  const place = row.tree.placeOf(row.task);
  const other = next.tree.placeOf(next.task);
  const key = decidingKey(place, other);
  if (key === undefined || key === 'pinned' || key === 'age' || planOrder(place, other) > 0) {
    return undefined;
  }
  switch (key) {
    case 'band':
      return place.ranked?.band === 0 ? 'expedite' : undefined;
    case 'score':
      return place.ranked === undefined ? undefined : scoreText(place.ranked);
    case 'started':
      return 'in progress';
    case 'due':
      return 'due';
    case 'unblocks':
      return place.unblocks === undefined ? undefined : unblocksText(place.unblocks);
    case 'week':
      return row.task.week === null ? undefined : `in week ${showStored(row.task.week, row.tree.zone)}`;
    case 'size':
      return row.task.size === null ? undefined : `size ${sizeText(row.task.size)}`;
  }
}

/** `score 21.3 (A1 #1)`: the score as stored, and the ranked goal it serves when it serves one. */
function scoreText({ score, goal }: RankedPlace): string {
  return goal === null ? `score ${score}` : `score ${score} (${goal.tag} #${goal.rank})`;
}

/** `unblocks T566 p1 +2`: the first needer of the best priority, that priority, and how many others need the task. */
function unblocksText({ first, priority, count }: Unblocks): string {
  return `unblocks ${first} ${priorityText(priority)}${count > 1 ? ` +${count - 1}` : ''}`;
}

/** ` · ahead: in progress`: {@link aheadReason} as the tail of a row; empty for the last row or when there is none. */
export function aheadText(row: PlacedRow, next: PlacedRow | undefined): string {
  const reason = next === undefined ? undefined : aheadReason(row, next);
  return reason === undefined ? '' : ` · ahead: ${reason}`;
}

/** The GitHub issue a task was imported from, as its ref (`gh:acme/web#7`); undefined for any other task. */
function issueOf(task: Task): string | undefined {
  return task.source === GITHUB_SOURCE && task.ref !== null ? task.ref : undefined;
}

/**
 * One line that names each field, so a newcomer can read it:
 * `T12 in-progress, p2, owner alpha, due 01-15, week 01-13, from lead, goals G1 | title`; a task imported from
 * GitHub is `from` its issue (`from gh:acme/web#7`).
 * With `team`, the id reads `<team>/T12`; `tree` gives the effective due, a waiting task's ready reasons and the
 * tasks of other sessions that need it, as in {@link formatShortTask}.
 */
export function formatTask(task: Task, team: string | undefined, tree: TaskTree): string {
  const parts = rowHead(task, team, tree);
  if (task.week !== null) {
    parts.push(`week ${showStored(task.week, tree.zone)}`);
  }
  parts.push(`from ${issueOf(task) ?? task.source}`);
  if (task.goals.length > 0) {
    parts.push(`goals ${task.goals.join(',')}`);
  } else if (task.noGoal) {
    parts.push('goals none');
  }
  if (task.workClass !== null) {
    parts.push(`class ${task.workClass}`);
  }
  return `${parts.join(', ')} | ${task.title}${statusNote(task, tree)}${neededByText(task, tree)}`;
}

/**
 * What a row adds for a status that waits on something: a waiting task's reasons, then its note
 * (`(waiting: decision owner · on T5; the schema first)`), or what will prove a verifying one, then what that
 * proof waits for (`(proof: the night's flow; waiting: on T7)`), or the sighting a done one is watched for
 * (`(watch: the night's flow lists it)`).
 */
function statusNote(task: Task, tree: TaskTree): string {
  if (task.status === 'waiting') {
    const parts = [task.waits.length > 0 || task.decided !== null ? waitingText(task, tree) : null, task.note].filter((part) => part !== null);
    return parts.length === 0 ? '' : ` (waiting: ${parts.join('; ')})`;
  }
  if (task.watch !== null) {
    return ` (watch: ${task.watch})`;
  }
  const proof = task.status === 'verifying' ? proofOf(task) : null;
  const waits = task.waits.length > 0 ? `; waiting: ${waitsText(task.waits, tree.zone, tree.context)}` : '';
  return proof === null ? '' : ` (proof: ${proof}${waits})`;
}

/**
 * A waiting task's reasons, then the lead's answer to its approval once given (`approval lead · lead approved`), and
 * the owner's decision once a leader recorded it (`owner decided, by lead`, T1366), so no one asks twice.
 */
function waitingText(task: Task, tree: TaskTree): string {
  const reasons = task.waits.length === 0 ? [] : [waitsText(task.waits, tree.zone, tree.context)];
  const answer = task.answer === null ? [] : [`${task.answer.by} ${task.answer.verdict}`];
  const decided = task.decided === null ? [] : [`owner decided, by ${task.decided.by}`];
  return [...reasons, ...answer, ...decided].join(' · ');
}

/** How much of a description an update line in `show`'s history quotes. */
const HISTORY_DESCRIPTION_CHARS = 80;

/**
 * One field of an update, as `show` prints it: a priority reads `p2`, a list joins with commas (empty goals read
 * `none`), and a description is quoted on one line, cut to HISTORY_DESCRIPTION_CHARS (`none` when cleared): `show`
 * prints the whole one above. A cleared size or work class reads `none`. A due time reads in the team's `zone`.
 */
function changeText(name: string, value: unknown, zone: TimeZone): string {
  if (name === 'due' && typeof value === 'string') {
    return storedText(value, zone);
  }
  if (name === 'priority' && typeof value === 'number') {
    return priorityText(value);
  }
  if (name === 'description') {
    return typeof value === 'string' ? JSON.stringify(cut(value.replace(/\s+/g, ' '), HISTORY_DESCRIPTION_CHARS)) : 'none';
  }
  if (name === 'size') {
    return typeof value === 'number' ? sizeText(value) : 'none';
  }
  if (name === 'workClass') {
    return typeof value === 'string' ? value : 'none';
  }
  if (name === 'goals' && Array.isArray(value) && value.length === 0) {
    return 'none';
  }
  return Array.isArray(value) ? value.join(',') : String(value);
}

/** One line per event, for `show`, its times in the team's `zone`. */
export function formatEvent(event: RegisterEvent, zone: TimeZone): string {
  const head = `${zone.minute(new Date(event.at))} ${event.by} ${event.type}`;
  const note = 'note' in event && event.note !== null ? ` note="${event.note}"` : '';
  switch (event.type) {
    case 'create': {
      const { task } = event;
      return [
        head,
        `owner=${task.owner}`,
        `source=${task.source}`,
        `priority=${priorityText(task.priority)}`,
        task.ref === null ? undefined : `ref=${task.ref}`,
        task.due === null ? undefined : `due=${storedText(task.due, zone)}`,
        task.week === null ? undefined : `week=${task.week}`,
        task.goals.length > 0 ? `goals=${task.goals.join(',')}` : task.noGoal ? 'goals=none' : undefined,
        task.after.length === 0 ? undefined : `after=${task.after.join(',')}`,
        task.size === null ? undefined : `size=${sizeText(task.size)}`,
        task.type === null ? undefined : `type=${task.type}`,
        task.critical ? 'critical=true' : undefined,
        task.workClass === null ? undefined : `workClass=${task.workClass}`,
      ]
        .filter((part) => part !== undefined)
        .join(' ');
    }
    case 'status':
      return [
        `${head} ${event.status}${event.waits === undefined ? '' : ` waits="${waitsText(event.waits, zone)}"`}${note}`,
        event.proof === undefined ? undefined : `proof="${event.proof}"`,
        event.watch === undefined ? undefined : `watch="${event.watch}"`,
        event.met === undefined ? undefined : `met="${event.met}"`,
        event.evidence === null ? undefined : `evidence=${event.evidence}`,
        event.skill === null ? undefined : `skill=${event.skill}`,
        event.followups === undefined ? undefined : `followups=${event.followups.length === 0 ? 'none' : event.followups.join(',')}`,
        event.review === undefined ? undefined : `review=${reviewPartNames(event.review)}`,
      ]
        .filter((part) => part !== undefined)
        .join(' ');
    case 'update': {
      // A no-goal mark changes only with the goals, whose own text says it: `goals=none`, or the tags (T1730).
      const fields = Object.entries(event.changes)
        .filter(([name]) => name !== 'noGoal' || event.changes.goals === undefined)
        .map(([name, value]) => `${name}=${changeText(name, value, zone)}`);
      const verdict = event.verdict === undefined ? [] : [`verdict=${event.verdict}`];
      const decided = event.decided === true ? ['decided'] : [];
      return `${[head, ...fields, ...verdict, ...decided].join(' ')}${note}`;
    }
    case 'moved':
      return `${head} to=${event.to}`;
  }
}

/** What a size, in percent of the weekly limit, costs in other words (such as `about 9.75M W`); undefined when unknown. */
export type SizeCost = (pct: number) => string | undefined;

/** What `show` adds to a task's own fields: its size's cost in other words, and its files line (T1457). */
export interface DetailExtras {
  readonly sizeCost?: SizeCost;
  readonly files?: string;
}

/**
 * `show`: the task line, its description (what and why, its later lines indented two spaces), its status details,
 * its files, then its history; `tree` reads the task line as {@link formatTask} does, and `extras.sizeCost` words its
 * size's cost beside the percent.
 */
export function formatTaskDetail(task: Task, events: readonly RegisterEvent[], tree: TaskTree, extras: DetailExtras = {}): string {
  const lines = [formatTask(task, undefined, tree)];
  if (task.description !== null) {
    const [first = '', ...rest] = task.description.split('\n');
    lines.push(`description: ${first}`, ...rest.map((line) => (line.trim() === '' ? '' : `  ${line}`)));
  }
  if (task.ref !== null) {
    lines.push(`ref: ${task.ref}`);
  }
  if (task.pin !== null) {
    lines.push(`pinned by ${task.pin}: above every other task of ${task.owner}`);
  }
  if (task.size !== null) {
    const cost = extras.sizeCost?.(task.size);
    lines.push(`size: ${sizeText(task.size)} of the weekly limit${cost === undefined ? '' : `, ${cost}`}`);
  }
  if (task.note !== null) {
    lines.push(`note: ${task.note}`);
  }
  if (task.card !== null) {
    lines.push('card:', ...cardLines(task.card, '  '));
  }
  if (task.answer !== null) {
    lines.push(`answer: ${task.answer.by} ${task.answer.verdict} at ${tree.zone.minute(new Date(task.answer.at))}${task.answer.note === null ? '' : `: ${task.answer.note}`}`);
  }
  if (task.decided !== null) {
    lines.push(`decided: ${task.decided.by} at ${tree.zone.minute(new Date(task.decided.at))}${task.decided.note === null ? '' : `: ${task.decided.note}`}`);
  }
  if (task.proof !== null) {
    lines.push(`proof: ${task.proof}`);
  }
  if (task.watch !== null) {
    lines.push(`watch: ${task.watch}`);
  }
  if (task.evidence !== null) {
    lines.push(`evidence: ${task.evidence}`);
  }
  if (task.skill !== null) {
    lines.push(`skill: ${task.skill}`);
  }
  if (task.followups.length > 0) {
    lines.push(`followups: ${task.followups.join(', ')}`);
  }
  const review = reviewLines(task.review, '  ');
  if (review.length > 0) {
    lines.push('review:', ...review);
  }
  if (extras.files !== undefined) {
    lines.push(extras.files);
  }
  lines.push('history:', ...events.filter((event) => event.id === task.id).map((event) => `  ${formatEvent(event, tree.zone)}`));
  return lines.join('\n');
}

/**
 * `show --tree`: what the task needs, down to tasks that need nothing unfinished (`needs:`), then the active tasks
 * that need it, up to those nothing needs (`needed by:`), each level indented two more spaces, then
 * {@link formatNextMove}. A finished need ends its branch, and so does one another register of the team tree holds,
 * read as its row there (`web/T3 open, ...`); one no register holds reads `T3 finished` (only a compaction retires a
 * task, and only a finished one). Within a part, a task met again reads `T4 (shown above)`, and one already on its
 * own branch `T2 (loop)`. Needs come in plan order, so the first branch leads to the next move. With `team`, the
 * read is that team's register, another than the caller's: its rows and its next move name it too (`web/T4`).
 */
export function formatTaskTree(task: Task, tree: TaskTree, titleChars: number, team: string | undefined = undefined): string[] {
  const node = (id: string) => {
    const found = tree.task(id);
    const away = tree.elsewhereOf(id);
    if (found !== undefined) {
      return shortRow(found, titleChars, team, tree);
    }
    return away === undefined ? `${id} finished` : shortRow(away.task, titleChars, away.team, tree);
  };
  const down = (id: string) => {
    const found = tree.task(id);
    if (found === undefined || (id !== task.id && !ACTIVE_STATUSES.includes(found.status))) {
      return [];
    }
    const needs = tree.needs(id);
    const known = tree.inPlanOrder(needs.flatMap((need) => tree.task(need) ?? [])).map((need) => need.id);
    return [...known, ...needs.filter((need) => tree.task(need) === undefined)];
  };
  const up = (id: string) => tree.neededBy(id).map((needer) => needer.id);
  const part = (name: string, next: (id: string) => string[]) => {
    const lines = branchLines(task.id, next, node, new Set([task.id]), [task.id]);
    return lines.length === 0 ? [`${name}: none`] : [`${name}:`, ...lines];
  };
  return [...part('needs', down), ...part('needed by', up), formatNextMove(task, tree, team)];
}

/** The lines under `id` along `next`, depth first, two spaces deeper per level; see {@link formatTaskTree}. */
function branchLines(id: string, next: (id: string) => string[], node: (id: string) => string, shown: Set<string>, path: readonly string[]): string[] {
  const indent = '  '.repeat(path.length);
  return next(id).flatMap((child) => {
    if (path.includes(child)) {
      return [`${indent}${child} (loop)`];
    }
    if (shown.has(child)) {
      return [`${indent}${child} (shown above)`];
    }
    shown.add(child);
    return [`${indent}${node(child)}`, ...branchLines(child, next, node, shown, [...path, child])];
  });
}

/**
 * `Next move: beta (T3)`: who moves first so the task can finish, on which task ({@link TaskTree.nextMove}), with
 * `, decision` or `, approval` when the lead or the owner decides, `, from Thu 01-10` when a time must pass first,
 * and `, behind T7 (p1)` when that session works a higher-priority task first; `Next move: lead on team web (web/T5)`
 * when an unfinished task of another register of the team tree comes first. `Next move: none` says why: the task
 * is finished, or what it needs runs in a loop. With `team`, the read is that team's register, another than the
 * caller's, which each move and task names: `Next move: beta on team web (web/T3)`.
 */
export function formatNextMove(task: Task, tree: TaskTree, team: string | undefined = undefined): string {
  const move = tree.nextMove(task.id);
  if (move === undefined) {
    return ACTIVE_STATUSES.includes(task.status)
      ? `Next move: none, what ${taskLabel(task, team)} needs runs in a loop (check flags it LOOP)`
      : `Next move: none, ${taskLabel(task, team)} is ${task.status}`;
  }
  if (move.kind === 'elsewhere') {
    return `Next move: ${move.who} on team ${move.team} (${taskLabel(move.need, move.team)})`;
  }
  const who = team === undefined ? move.who : `${move.who} on team ${team}`;
  const what = move.kind === 'work' ? '' : move.kind === 'time' ? `, from ${weekdayText(move.at, tree.zone)}` : `, ${move.kind}`;
  const behind = move.behind === undefined ? '' : `, behind ${taskLabel(move.behind, team)} (${priorityText(move.behind.priority)})`;
  return `Next move: ${who} (${taskLabel(move.task, team)})${what}${behind}`;
}

/**
 * A row of the waiting-on-you block: another session's task as its short row, then what it waits on from you:
 * ` · needs your T2, T3` and ` · waits on your decision and approval`.
 */
export function formatWaitingOnYou(entry: WaitingOnYou, titleChars: number, tree: TaskTree): string {
  const needs = entry.needs.length === 0 ? '' : ` · needs your ${entry.needs.map((need) => need.id).join(', ')}`;
  const asks = entry.asks.length === 0 ? '' : ` · waits on your ${entry.asks.map((ask) => ask.kind).join(' and ')}`;
  return `${shortRow(entry.task, titleChars, undefined, tree)}${needs}${asks}`;
}

/**
 * The inbox line a task's new owner gets, under the giver's name, a due time in the team's `zone`:
 * `T5 is yours (p2, due 2030-01-10): Show the signup errors`.
 */
export function assignedNotice(task: Pick<Task, 'id' | 'priority' | 'due' | 'title'>, zone: TimeZone): string {
  return `${task.id} is yours (${priorityAndDue(task, zone)}): ${task.title}`;
}

/**
 * The copy line a team's lead gets, under the asker's `<team>/<id>`, when a session of another team asks one of its
 * sessions for work (T1141), so the lead, who sets its team's work order, can reorder or reassign it:
 * `T5 went to front (p2): Show the signup errors; reorder or reassign it: teamrig update T5 --priority|--after|--owner`.
 */
export function askedNotice(task: Pick<Task, 'id' | 'owner' | 'priority' | 'due' | 'title'>, zone: TimeZone): string {
  return `${task.id} went to ${task.owner} (${priorityAndDue(task, zone)}): ${task.title}; reorder or reassign it: teamrig update ${task.id} --priority|--after|--owner`;
}

function priorityAndDue(task: Pick<Task, 'priority' | 'due'>, zone: TimeZone): string {
  return `${priorityText(task.priority)}${task.due === null ? '' : `, due ${storedText(task.due, zone)}`}`;
}

/**
 * The inbox line telling a task's owner the lead's answer to its approval wait (T684): an approval sends it to push or
 * merge what it asked for; a decline sends it back to work, the note saying why, and it asks again when that is fixed.
 */
export function approvalNotice(task: Pick<Task, 'id'>, answer: ApprovalAnswer): string {
  const note = answer.note === null ? '' : `: ${answer.note.replace(/\s+/g, ' ')}`;
  return answer.verdict === 'approved'
    ? `${answer.by} approved ${task.id}${note}; push or merge it now, then set its next status`
    : `${answer.by} declined ${task.id}${note}; set it in-progress, fix that, then ask again (--status waiting --waits approval:${answer.by})`;
}

/**
 * The inbox line a session of another team gets when a task it asked of `team` ends (T509, T1141), the task named
 * `<team>/<id>`: a done one with its evidence, a dropped one with its note, `web/T1 done: Ship login | evidence: PR #12 merged`.
 */
export function endedNotice(task: Pick<Task, 'id' | 'status' | 'title' | 'note' | 'evidence'>, team: string): string {
  const [label, why] = task.status === 'done' ? ['evidence', task.evidence] : ['note', task.note];
  return `${team}/${task.id} ${task.status}: ${task.title}${why === null ? '' : ` | ${label}: ${why.replace(/\s+/g, ' ')}`}`;
}

/**
 * The inbox line telling a leader (the lead, or a sub-lead, T781) that a task now waits on it, or, for the lead, on
 * the owner, whose decision queue the lead keeps: `T2 waits on your approval and the owner's decision: <note>`, the
 * note (else the title) on one line.
 */
export function personWaitNotice(task: Pick<Task, 'id' | 'note' | 'title' | 'card'>, waits: readonly PersonWait[], receiver: string): string {
  const kindsOf = (onReceiver: boolean) => waits.filter((reason) => (reason.who === receiver) === onReceiver).map((reason) => reason.kind);
  const yours = kindsOf(true);
  const owners = kindsOf(false);
  const whose = [yours.length === 0 ? '' : `your ${yours.join(' and ')}`, owners.length === 0 ? '' : `the owner's ${owners.join(' and ')}`];
  return `${task.id} waits on ${whose.filter((part) => part !== '').join(' and ')}: ${(task.card?.question ?? task.note ?? task.title).replace(/\s+/g, ' ')}`;
}
