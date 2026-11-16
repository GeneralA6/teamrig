import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { KIT_NAME } from '../../core/home.ts';
import { SecretScanner } from '../../core/secrets.ts';
import type { TimeZone } from '../../core/zone.ts';
import { sliceLabel, type GoalSliceInput } from '../../register/goal-slices.ts';
import { GoalStore, type GoalWrite, type GoalWriter } from '../../register/goal-store.ts';
import { FIRST_GOAL_RANK, FIRST_SLICE, GOAL_TAG, isGoalDay, isGoalRank, isSlice, MAX_GOAL_RANK, NO_GOAL, type Goal, type GoalsRead, type Slice } from '../../register/goals.ts';
import { noPositionals, onePositional, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { fileLockOf } from '../file-locks.ts';
import { callerOf, listOf, sizeOf, taskIdOf } from '../inputs.ts';
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf, teamZone, type Access } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';

/**
 * `goal add|set|rank|slice|list|show` (T1730, rank T2083, slice T2203): the team's goal records, each a tag, a title and a
 * planned window from its start to its target day, every move of that target with the note saying why (a slip), and
 * its rank, 1 first, which goal-first ranking gives the tasks serving it.
 * Only the team's lead adds, changes or ranks one, under the goals lock (register/goal-store.ts); any session reads them.
 * The records sit in `goals.jsonl` beside the register's events, so the pane's Goals section reads them itself.
 */

interface GoalsKit {
  readonly config: KitConfig;
  readonly roster: Roster;
  readonly store: GoalStore;
  readonly path: string;
  readonly zone: TimeZone;
  readonly now: number;
}

async function goalsKit(runtime: CliRuntime, access: Access): Promise<GoalsKit> {
  const found = await findTeam(runtime);
  const kit = await openKit(runtime, found.team);
  const config = requireConfig(kit, runtime, access);
  return {
    config,
    roster: await rosterOf(runtime, kit, config),
    store: new GoalStore(runtime.files, kit.paths.goals, fileLockOf(runtime, kit.paths.goalsLock, config.lock)),
    path: kit.paths.goals,
    zone: teamZone(config, runtime),
    now: runtime.clock.now(),
  };
}

/** The caller as a goal's writer: the team's lead, else refused. */
function leadWriter(gk: GoalsKit, args: ParsedArgs, runtime: CliRuntime): GoalWriter {
  const caller = sessionIdOf(gk.roster, callerOf(args.flags, runtime.env));
  const lead = gk.roster.holderOf('lead');
  if (caller !== lead) {
    throw new RefusedError(`only the lead${lead === undefined ? '' : ` (${gk.roster.nameOf(lead) ?? lead})`} adds and changes the team's goals`);
  }
  return { by: caller, at: new Date(gk.now).toISOString() };
}

/** A goal tag as typed, checked for its shape. */
function checkedTag(tag: string): string {
  if (tag === NO_GOAL || !GOAL_TAG.test(tag)) {
    throw new UsageError(`"${tag}" is not a goal tag: a letter, then letters, digits, . or -, at most 24 characters, never "${NO_GOAL}"`);
  }
  return tag;
}

/** The goal tag the command names as its one positional, checked for its shape. */
function tagOf(args: ParsedArgs): string {
  return checkedTag(onePositional(args, 'goal tag'));
}

/** What `goal rank` takes in place of a rank to take a goal off the ranking. */
const NO_RANK = 'none';

/** The rank `goal rank` names: a whole number from 1 to 99, or none (null). */
function rankArgOf(text: string): number | null {
  if (text === NO_RANK) {
    return null;
  }
  const rank = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!isGoalRank(rank)) {
    throw new UsageError(`"${text}" is not a rank: a whole number from ${FIRST_GOAL_RANK} to ${MAX_GOAL_RANK}, or ${NO_RANK}`);
  }
  return rank;
}

/** A slice's number, a whole number from 1, as `what` names it: `--slice` is the goal's open one (T2453). */
function sliceArgOf(text: string, what = '--slice'): number {
  const slice = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!isSlice(slice)) {
    throw new UsageError(`${what} "${text}" is not a whole number from ${FIRST_SLICE}`);
  }
  return slice;
}

/** A day flag, `YYYY-MM-DD`. */
function dayOf(flag: string, text: string): string {
  const day = text.trim();
  if (!isGoalDay(day)) {
    throw new UsageError(`--${flag} "${text}" is not a YYYY-MM-DD day`);
  }
  return day;
}

/** A text flag that is one line, at most `max` characters and no secret. */
function lineOf(flag: string, text: string, max: number, secrets: SecretScanner): string {
  const line = text.trim();
  if (line === '' || /[\r\n]/.test(line)) {
    throw new UsageError(`--${flag} is one non-empty line`);
  }
  const length = [...line].length;
  if (length > max) {
    throw new UsageError(`--${flag} holds ${length} characters: at most ${max}`);
  }
  const refusal = secrets.refusal(`--${flag}`, line);
  if (refusal !== undefined) {
    throw new RefusedError(refusal);
  }
  return line;
}

function slipsText(goal: Goal): string {
  const count = goal.slips.length;
  return count === 0 ? '' : `, ${count} slip${count === 1 ? '' : 's'}`;
}

/** One goal as a list line: its tag, window, slips, parent, rank, open slice and slice records, then its title. */
export function goalLine(goal: Goal): string {
  const slices = goal.slices.length === 0 ? '' : `, ${goal.slices.length} slice record${goal.slices.length === 1 ? '' : 's'}`;
  const parent = goal.parent === null ? '' : `, part of ${goal.parent}`;
  const rank = goal.rank === null ? '' : `, rank ${goal.rank}`;
  const slice = goal.slice === null ? '' : `, slice ${goal.slice}`;
  return `${goal.tag} ${goal.start} to ${goal.target}${slipsText(goal)}${parent}${rank}${slice}${slices} | ${goal.title}`;
}

/**
 * The rows `goal list` prints: the ranked goals first, by rank (a tie in the order added), each on its own, then the
 * unranked ones as a tree; an unranked part of a ranked goal heads its own branch, its line naming the goal it is
 * part of.
 */
export function goalListRows(goals: ReadonlyMap<string, Goal>): Array<{ readonly goal: Goal; readonly depth: number }> {
  const all = [...goals.values()];
  const ranked = all.filter((goal) => goal.rank !== null).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const unranked = new Map(all.filter((goal) => goal.rank === null).map((goal) => [goal.tag, goal]));
  return [...ranked.map((goal) => ({ goal, depth: 0 })), ...goalTree(unranked)];
}

/** The goals as a tree: each top goal in the order added, then its parts under it, one level deeper each. */
export function goalTree(goals: ReadonlyMap<string, Goal>): Array<{ readonly goal: Goal; readonly depth: number }> {
  const children = new Map<string | null, Goal[]>();
  for (const goal of goals.values()) {
    const parent = goal.parent !== null && goals.has(goal.parent) ? goal.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), goal]);
  }
  const rows: Array<{ readonly goal: Goal; readonly depth: number }> = [];
  const visit = (parent: string | null, depth: number): void => {
    for (const goal of children.get(parent) ?? []) {
      rows.push({ goal, depth });
      visit(goal.tag, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

/** Warns on stderr about lines of the goals file that fold to no goal. */
function warnDamage(runtime: CliRuntime, read: GoalsRead, path: string): void {
  if (read.unreadable + read.newer + read.ignored > 0) {
    runtime.out.stderr(`WARN ${path}: ${read.unreadable} unreadable line(s), ${read.newer} line(s) from a newer ${KIT_NAME}, ${read.ignored} record(s) naming no goal or a second add`);
  }
}

/** Prints a write's goal as it now reads, or refuses with the store's reason. */
async function written(runtime: CliRuntime, gk: GoalsKit, verb: string, write: GoalWrite): Promise<ExitCode> {
  if (write.kind === 'refused') {
    throw new RefusedError(write.reason);
  }
  const goal = (await gk.store.read()).goals.get(write.record.tag);
  runtime.out.stdout(`${verb} goal ${goal === undefined ? write.record.tag : goalLine(goal)}`);
  return EXIT.ok;
}

/**
 * `goal add <tag> --title "<title>" --target <YYYY-MM-DD> [--start <YYYY-MM-DD>] [--parent <tag>]`: the lead adds a
 * goal; its start is today by default. A key result (a goal with a parent) is refused past focus.maxActiveKeyResults
 * open ones.
 */
export async function goalAdd(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const tag = tagOf(args);
  const gk = await goalsKit(runtime, 'write');
  const writer = leadWriter(gk, args, runtime);
  const secrets = new SecretScanner(gk.config.register.secretPatterns);
  const start = args.flags.get('start');
  const parent = args.flags.get('parent')?.trim();
  const today = gk.zone.day(new Date(gk.now));
  const input = {
    tag,
    title: lineOf('title', requiredFlag(args.flags, 'title'), gk.config.register.maxTitle, secrets),
    start: start === undefined ? today : dayOf('start', start),
    target: dayOf('target', requiredFlag(args.flags, 'target')),
    parent: parent === undefined || parent === '' ? null : parent,
  };
  const cap = { max: gk.config.focus.maxActiveKeyResults, today };
  return written(runtime, gk, 'ADDED', await gk.store.add(input, writer, cap));
}

/** `goal rank <tag> <n>|none`: the lead ranks a goal, 1 first, or takes it off the ranking. */
export async function goalRank(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const [tag, rank, extra] = args.positionals;
  if (tag === undefined || rank === undefined) {
    throw new UsageError(`${args.command} needs <goal tag> <rank>|${NO_RANK}`);
  }
  if (extra !== undefined) {
    throw new UsageError(`unexpected "${extra}"`);
  }
  const input = { tag: checkedTag(tag), rank: rankArgOf(rank) };
  const gk = await goalsKit(runtime, 'write');
  const writer = leadWriter(gk, args, runtime);
  return written(runtime, gk, input.rank === null ? 'UNRANKED' : 'RANKED', await gk.store.rank(input, writer));
}

/** `goal set <tag> [--target <YYYY-MM-DD>] [--title "<title>"] --note "<why>"`: the lead moves a goal's target (a slip) or renames it. */
export async function goalSet(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const tag = tagOf(args);
  const gk = await goalsKit(runtime, 'write');
  const writer = leadWriter(gk, args, runtime);
  const secrets = new SecretScanner(gk.config.register.secretPatterns);
  const target = args.flags.get('target');
  const title = args.flags.get('title');
  const slice = args.flags.get('slice');
  const input = {
    tag,
    slice: slice === undefined ? null : sliceArgOf(slice),
    target: target === undefined ? null : dayOf('target', target),
    title: title === undefined ? null : lineOf('title', title, gk.config.register.maxTitle, secrets),
    note: lineOf('note', requiredFlag(args.flags, 'note'), gk.config.register.maxText, secrets),
  };
  return written(runtime, gk, 'SET', await gk.store.set(input, writer));
}

/** One slice as a line: its label, title, owner, ship day, tasks, size, then its proof and whether it is proven. */
export function sliceLine(tag: string, slice: Slice): string {
  const size = slice.size === null ? '' : `, size ${slice.size}%`;
  const proven = slice.proven === null ? 'not proven' : `proven by ${slice.proven.by}: ${slice.proven.evidence}`;
  return `${sliceLabel(tag, slice.number)} ${slice.title} | owner ${slice.owner}, ships ${slice.ship}, tasks ${slice.tasks.join(',')}${size} | proof: ${slice.proof} | ${proven}`;
}

/** An optional text flag of `goal slice`: null when it is not given. */
function optionalLine(args: ParsedArgs, flag: string, max: number, secrets: SecretScanner): string | null {
  const text = args.flags.get(flag);
  return text === undefined ? null : lineOf(flag, text, max, secrets);
}

/**
 * `goal slice <tag> <n> [--title "<title>"] [--owner <session>] [--ship <YYYY-MM-DD>] [--proof "<live proof>"]
 * [--tasks T1,T2] [--size <pct>] [--proven "<evidence>"] --note "<why>"` (T2203): the lead adds a shippable slice of a
 * goal, naming all but its size and evidence, or changes it; a ship day move is a slip kept with its note. Its owner
 * may record --proven alone, once the live proof exists.
 */
export async function goalSlice(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const [tag, number, extra] = args.positionals;
  if (tag === undefined || number === undefined) {
    throw new UsageError(`${args.command} needs <goal tag> <slice number>`);
  }
  if (extra !== undefined) {
    throw new UsageError(`unexpected "${extra}"`);
  }
  const gk = await goalsKit(runtime, 'write');
  const by = sessionIdOf(gk.roster, callerOf(args.flags, runtime.env));
  const secrets = new SecretScanner(gk.config.register.secretPatterns);
  const { maxTitle, maxText } = gk.config.register;
  const owner = args.flags.get('owner');
  const ship = args.flags.get('ship');
  const tasks = args.flags.get('tasks');
  const size = args.flags.get('size');
  const input: GoalSliceInput = {
    tag: checkedTag(tag),
    slice: sliceArgOf(number, 'slice'),
    title: optionalLine(args, 'title', maxTitle, secrets),
    owner: owner === undefined ? null : sessionIdOf(gk.roster, owner),
    ship: ship === undefined ? null : dayOf('ship', ship),
    proof: optionalLine(args, 'proof', maxText, secrets),
    tasks: tasks === undefined ? null : listOf('--tasks', tasks).map(taskIdOf),
    size: size === undefined ? null : sizeOf(size),
    proven: optionalLine(args, 'proven', maxText, secrets),
    note: lineOf('note', requiredFlag(args.flags, 'note'), maxText, secrets),
  };
  const write = await gk.store.slice(input, { by, at: new Date(gk.now).toISOString() }, gk.roster.holderOf('lead'));
  if (write.kind === 'refused') {
    throw new RefusedError(write.reason);
  }
  const slice = (await gk.store.read()).goals.get(input.tag)?.slices.find((each) => each.number === input.slice);
  runtime.out.stdout(`SLICE ${slice === undefined ? sliceLabel(input.tag, input.slice) : sliceLine(input.tag, slice)}`);
  return EXIT.ok;
}

/** `goal list`: the team's goals, the ranked ones first, then the rest as a tree, one line each. */
export async function goalList(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const gk = await goalsKit(runtime, 'read');
  const read = await gk.store.read();
  warnDamage(runtime, read, gk.path);
  if (read.goals.size === 0) {
    runtime.out.stdout(`GOALS 0: the lead adds one with ${KIT_NAME} goal add <tag> --title "<title>" --target <YYYY-MM-DD>`);
    return EXIT.ok;
  }
  const ranked = [...read.goals.values()].filter((goal) => goal.rank !== null).length;
  runtime.out.stdout(`GOALS ${read.goals.size}${ranked === 0 ? '' : `, ${ranked} ranked first`} (${KIT_NAME} goal show <tag> prints one with its slips)`);
  goalListRows(read.goals).forEach(({ goal, depth }) => runtime.out.stdout(`${'  '.repeat(depth + 1)}${goalLine(goal)}`));
  return EXIT.ok;
}

/** `goal show <tag>`: one goal, who added it and when, its parts, each move of its target with the note saying why, and its slices. */
export async function goalShow(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const tag = tagOf(args);
  const gk = await goalsKit(runtime, 'read');
  const read = await gk.store.read();
  warnDamage(runtime, read, gk.path);
  const goal = read.goals.get(tag);
  if (goal === undefined) {
    throw new RefusedError(`${tag} is not a goal of the team: ${KIT_NAME} goal list lists them`);
  }
  goalShowLines(goal, read.goals, gk.zone).forEach((line) => runtime.out.stdout(line));
  return EXIT.ok;
}

/** What `goal show` prints for `goal`. */
export function goalShowLines(goal: Goal, goals: ReadonlyMap<string, Goal>, zone: TimeZone): string[] {
  const parts = [...goals.values()].filter((each) => each.parent === goal.tag).map((each) => each.tag);
  const added = goal.slips.length === 0 ? '' : ` (planned ${goal.slips[0]?.from ?? goal.target})`;
  return [
    `${goal.tag} | ${goal.title}`,
    `  window ${goal.start} to ${goal.target}${added}`,
    ...(goal.rank === null ? [] : [`  rank ${goal.rank}`]),
    ...(goal.slice === null ? [] : [`  slice ${goal.slice}`]),
    `  added ${zone.weekdayMinute(new Date(goal.addedAt))} by ${goal.addedBy}`,
    ...(goal.parent === null ? [] : [`  part of ${goal.parent}`]),
    ...(parts.length === 0 ? [] : [`  parts ${parts.join(', ')}`]),
    `  SLIPS ${goal.slips.length}`,
    ...goal.slips.map((slip) => `    ${zone.weekdayMinute(new Date(slip.at))} ${slip.by}: ${slip.from} -> ${slip.to} | ${slip.note}`),
    ...(goal.slices.length === 0 ? [] : [`  SLICES ${goal.slices.length}`]),
    ...goal.slices.flatMap((slice) => [
      `    ${sliceLine(goal.tag, slice)}`,
      ...slice.slips.map((slip) => `      ${zone.weekdayMinute(new Date(slip.at))} ${slip.by}: ships ${slip.from} -> ${slip.to} | ${slip.note}`),
    ]),
  ];
}
