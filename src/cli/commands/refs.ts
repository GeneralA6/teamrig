import { resolve } from 'node:path';
import { errorMessage } from '../../core/guards.ts';
import { RegisterPolicy } from '../../register/policy.ts';
import { parseRefChanges, planLine, planRefChanges, updateLine, type RefChange, type RefJudge, type RefRow } from '../../register/ref-changes.ts';
import { onePositional, type ParsedArgs } from '../args.ts';
import { callerOf } from '../inputs.ts';
import { sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { reportRotation } from './register.ts';
import { openTeam, type Team } from './register-team.ts';

/** The rows of the ref-change file at `path`; refused when it is missing, not JSON or not a list of rows. */
async function refChangesAt(runtime: CliRuntime, path: string): Promise<readonly RefChange[]> {
  const text = await runtime.files.read(path);
  if (text === undefined) {
    throw new RefusedError(`no ref-change file ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new RefusedError(`${path} is not JSON: ${errorMessage(error)}`);
  }
  const parsed = parseRefChanges(raw);
  if (!parsed.ok) {
    throw new RefusedError(`${path}: ${parsed.error}`);
  }
  return parsed.value;
}

/**
 * Writes each row planned `update` as `update <id> --ref <newRef>` by `by` would, so the register's policy judges
 * each write again under its lock; prints every row's line, and a rotation a write ran on stderr. The count of
 * writes it made and refused.
 */
async function writeRows(runtime: CliRuntime, team: Team, by: string, rows: readonly RefRow[]): Promise<{ readonly updated: number; readonly refused: number }> {
  let updated = 0;
  let refused = 0;
  for (const row of rows) {
    if (row.action !== 'update') {
      runtime.out.stdout(planLine(row));
      refused += row.action === 'refused' ? 1 : 0;
      continue;
    }
    const verdict = await team.register.update(by, row.change.id, { ref: row.change.newRef }, undefined);
    if (!verdict.ok) {
      runtime.out.stdout(`REFUSED ${row.change.id}: ${verdict.error}`);
      refused += 1;
      continue;
    }
    runtime.out.stdout(updateLine('UPDATED', row.change));
    reportRotation(runtime, verdict.value.rotation, team.paths);
    updated += 1;
  }
  return { updated, refused };
}

/**
 * `refs apply <file> [--yes]` (T1830): points the refs of the caller's team's tasks at notes that moved, from a file
 * of `{team, id, oldRef, newRef}` rows. A dry run (the default) writes nothing and names each row's fate, judged by
 * the register's own policy for the caller; `--yes` writes each row whose task still reads `oldRef`. A row of another
 * team, of a task that moved or is not in the working set, already on `newRef`, changed since, or one the policy
 * refuses the caller is left. Exits refused when `--yes` left a row the policy refused.
 */
export async function apply(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const path = resolve(runtime.cwd, onePositional(args, 'file'));
  const caller = callerOf(args.flags, runtime.env);
  const team = await openTeam(runtime, 'write');
  const by = sessionIdOf(team.roster, caller);
  const policy = new RegisterPolicy(team.config, team.above);
  const notOnTeam = policy.checkCaller(by);
  if (notOnTeam !== undefined) {
    throw new RefusedError(notOnTeam);
  }
  const changes = await refChangesAt(runtime, path);
  const { snapshot, elsewhere } = await team.register.snapshotWithElsewhere();
  const judge: RefJudge = (task, change) => {
    const verdict = policy.update(task, by, { ref: change.newRef }, undefined, snapshot.state, elsewhere);
    return verdict.ok ? undefined : verdict.error;
  };
  const rows = planRefChanges(changes, team.paths.team, snapshot.state, judge);
  if (!args.switches.has('yes')) {
    rows.forEach((row) => runtime.out.stdout(planLine(row)));
    const updates = rows.filter((row) => row.action === 'update').length;
    runtime.out.stdout(`dry run: would update ${updates}, left ${rows.length - updates}; nothing was written: rerun with --yes to write`);
    return EXIT.ok;
  }
  const { updated, refused } = await writeRows(runtime, team, by, rows);
  runtime.out.stdout(`updated ${updated}, left ${rows.length - updated}${refused > 0 ? `, ${refused} of them refused` : ''}`);
  return refused > 0 ? EXIT.refused : EXIT.ok;
}
