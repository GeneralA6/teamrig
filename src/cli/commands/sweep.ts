import { resolve } from 'node:path';
import type { TeamTree } from '../../config/tree.ts';
import { formatAddress, type SessionAddress } from '../../core/address.ts';
import type { SizeBase } from '../../register/events.ts';
import type { Task } from '../../register/fold.ts';
import { ACTIVE_STATUSES } from '../../register/model.ts';
import { RegisterPolicy, type Verdict } from '../../register/policy.ts';
import type { WriteResult } from '../../register/register.ts';
import { sizePctOf } from '../../register/score.ts';
import {
  countLines,
  formatSweepRows,
  parseSweepFile,
  planLine,
  planSweepRow,
  proposeRow,
  refusedPlan,
  tallyOf,
  tallyText,
  type SweepChanges,
  type SweepInput,
  type SweepPlan,
  type SweepRow,
} from '../../register/sweep.ts';
import { needsOf } from '../../register/tree.ts';
import { noPositionals, onePositional, type ParsedArgs } from '../args.ts';
import { callerOf } from '../inputs.ts';
import { findTeam, openKit, sessionIdOf } from '../kit.ts';
import type { RolledTeam } from '../roll-up.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { readSizeBase } from '../task-spend.ts';
import { KitTreeGoals } from '../tree-goals.ts';
import { readRegisters, reportRotation, warnDamage } from './register.ts';
import { teamOf, type Team } from './register-team.ts';
import { treeCallerOf } from './team-ask.ts';

function activeTasks(team: Pick<RolledTeam, 'snapshot'>): Task[] {
  return [...team.snapshot.state.tasks.values()].filter((task) => ACTIVE_STATUSES.includes(task.status));
}

/** Every id an active task of `teams`, or one they know of elsewhere, needs; ids are one numbering across a tree. */
function neededIds(teams: readonly RolledTeam[]): ReadonlySet<string> {
  const elsewhere = teams.flatMap((team) => [...team.elsewhere.values()].map(({ task }) => task));
  const tasks = [...teams.flatMap(activeTasks), ...elsewhere.filter((task) => ACTIVE_STATUSES.includes(task.status))];
  return new Set(tasks.flatMap((task) => needsOf(task)));
}

/** What the rows of `rolled` are proposed from. */
async function inputOf(runtime: CliRuntime, rolled: RolledTeam, needed: ReadonlySet<string>, now: number): Promise<SweepInput<Task>> {
  const { team, config, paths, ranking } = rolled;
  return {
    team,
    focus: config.focus,
    goals: await new KitTreeGoals(runtime, paths, config).all(),
    ownerSource: config.register.ownerSource,
    now,
    // The ranking's own chain, so a row proposes the size the plan's score divides by.
    sizeOf: (task) => sizePctOf(ranking.sizingOf(task), config.focus.score),
    needed: (id) => needed.has(id),
  };
}

/** The tasks of `rolled` a sweep covers: with `--tree` every one, else a `--session` narrows them to its own. */
function sweptTasks(args: ParsedArgs, rolled: RolledTeam): Task[] {
  const session = args.flags.get('session');
  if (args.switches.has('tree') || session === undefined) {
    return activeTasks(rolled);
  }
  const owner = sessionIdOf(rolled.roster, session);
  return activeTasks(rolled).filter((task) => task.owner === owner);
}

/**
 * `sweep [--tree] [--session <id>] [--out <file>]` (T2076): proposes each active task's class, objective and size, one
 * JSONL row each with `confirm` empty, and writes nothing to a register. On stdout alone the rows redirect into the very
 * file `sweep apply` reads, so the counts go to stderr; `--out` writes the file and leaves stdout to the counts.
 */
export async function sweep(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { teams } = await readRegisters(args, runtime);
  const now = runtime.clock.now();
  const needed = neededIds(teams);
  const rows: SweepRow[] = [];
  for (const rolled of teams) {
    warnDamage(runtime, rolled.snapshot, rolled.paths.events);
    const input = await inputOf(runtime, rolled, needed, now);
    rows.push(...sweptTasks(args, rolled).map((task) => proposeRow(task, input)));
  }
  const out = args.flags.get('out');
  if (out === undefined) {
    rows.forEach((row) => runtime.out.stdout(JSON.stringify(row)));
    countLines(rows).forEach((line) => runtime.out.stderr(line));
    return EXIT.ok;
  }
  const path = resolve(runtime.cwd, out);
  await runtime.files.write(path, formatSweepRows(rows));
  countLines(rows).forEach((line) => runtime.out.stdout(line));
  runtime.out.stdout(`WROTE ${String(rows.length)} row(s) to ${path}: set confirm to yes on the rows you agree with, then teamrig sweep apply`);
  return EXIT.ok;
}

/** The rows of the sweep file at `path`; refused when it is missing or damaged. */
async function sweepRowsAt(runtime: CliRuntime, path: string): Promise<readonly SweepRow[]> {
  const text = await runtime.files.read(path);
  if (text === undefined) {
    throw new RefusedError(`no sweep file ${path}`);
  }
  const parsed = parseSweepFile(text);
  if (!parsed.ok) {
    throw new RefusedError(`${path}: ${parsed.error}`);
  }
  return parsed.value;
}

function rowsByTeam(rows: readonly SweepRow[]): ReadonlyMap<string, readonly SweepRow[]> {
  const teams = new Map<string, SweepRow[]>();
  for (const row of rows) {
    teams.set(row.team, [...(teams.get(row.team) ?? []), row]);
  }
  return teams;
}

/** Why `from` may not write rows of team `team`; undefined for its own team, or one under a team it leads. */
function closedTo(from: SessionAddress, tree: TeamTree, team: string): string | undefined {
  if (team === from.team) {
    return undefined;
  }
  if (tree.leadOf(team) === undefined) {
    return `no team ${team} with a config in this kit home`;
  }
  const leadsAbove = tree.leadOf(from.team) === from.id && tree.ancestorsOf(team).includes(from.team);
  return leadsAbove ? undefined : `only ${team}'s own sessions or the lead of a team above it apply this row`;
}

/** One team's read and its two ways in: the judge a dry run asks, and the write that asks the register's policy again. */
interface SweepWriter {
  readonly team: Team;
  planOf(row: SweepRow): SweepPlan;
  write(id: string, changes: SweepChanges, sizeBase: SizeBase | undefined): Promise<Verdict<WriteResult>>;
}

/**
 * The rows of team `name` as `from` applies them. A team above writes through `triageFrom`, as this team's roster does
 * not hold it and {@link closedTo} already vetted it by the tree; its own sessions go through the roster's rules.
 */
async function writerOf(runtime: CliRuntime, from: SessionAddress, name: string): Promise<SweepWriter> {
  const team = await teamOf(runtime, await openKit(runtime, name), 'write');
  const policy = new RegisterPolicy(team.config, team.above);
  const reader = new KitTreeGoals(runtime, team.paths, team.config);
  const [{ snapshot, elsewhere }, goals, goalTags] = await Promise.all([team.register.snapshotWithElsewhere(), reader.all(), reader.read()]);
  const { state } = snapshot;
  const own = name === from.team;
  const by = own ? from.id : formatAddress(from);
  const judge = (task: Task, changes: SweepChanges): string | undefined => {
    const verdict = own ? policy.triage(task, by, changes, state, elsewhere, goalTags) : policy.triageFrom(task, changes, state, elsewhere, goalTags);
    return verdict.ok ? undefined : verdict.error;
  };
  return {
    team,
    planOf: (row) => planSweepRow(row, state.tasks.get(row.id), goals, judge),
    write: (id, changes, sizeBase) => (own ? team.register.triage(by, id, changes, sizeBase) : team.register.triageFrom(by, id, changes, sizeBase)),
  };
}

/** Writes one planned change, which the register's policy judges again under its lock; what became of the row. */
async function writeRow(runtime: CliRuntime, writer: SweepWriter, plan: SweepPlan): Promise<SweepPlan> {
  if (plan.action !== 'change') {
    return plan;
  }
  const { team } = writer;
  const { id } = plan.row;
  const sizeBase = plan.changes.size === undefined ? undefined : await readSizeBase(runtime, team.paths, team.config.sessions, id, runtime.clock.now());
  const verdict = await writer.write(id, plan.changes, sizeBase);
  if (!verdict.ok) {
    return { row: plan.row, action: 'refused', reason: verdict.error };
  }
  reportRotation(runtime, verdict.value.rotation, team.paths);
  return plan;
}

/**
 * `sweep apply <file> [--apply]` (T2076): writes the class, goal and size of each row a person set `confirm` to yes on,
 * as its task's owner or a leader over it, and never deletes or parks. A size lands only when it differs from the row's
 * `proposedSize`, so a median or floor size stays live (T2114). A dry run (the default) writes nothing. One row that
 * cannot land leaves the others: a person confirmed each on its own, so a bad one says why and the rest stand.
 * Exits refused when `--apply` left a refused row.
 */
export async function apply(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const path = resolve(runtime.cwd, onePositional(args, 'file'));
  const caller = callerOf(args.flags, runtime.env);
  const rows = await sweepRowsAt(runtime, path);
  const { team: home } = await findTeam(runtime);
  const { from, tree } = await treeCallerOf(runtime, home, caller, home);
  const writing = args.switches.has('apply');
  const plans: SweepPlan[] = [];
  for (const [name, teamRows] of rowsByTeam(rows)) {
    const closed = closedTo(from, tree, name);
    if (closed !== undefined) {
      plans.push(...teamRows.map((row) => refusedPlan(row, closed)));
      continue;
    }
    const writer = await writerOf(runtime, from, name);
    for (const row of teamRows) {
      const planned = writer.planOf(row);
      plans.push(writing ? await writeRow(runtime, writer, planned) : planned);
    }
  }
  plans.flatMap((plan) => planLine(plan, writing) ?? []).forEach((line) => runtime.out.stdout(line));
  const tally = tallyOf(plans);
  runtime.out.stdout(writing ? tallyText(tally) : `dry run: ${tallyText(tally)}; nothing was written: rerun with --apply to write`);
  return writing && tally.refused > 0 ? EXIT.refused : EXIT.ok;
}
