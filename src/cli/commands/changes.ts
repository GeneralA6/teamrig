import { parsePoint, readChanges, type ChangesReport } from '../../changes/read.ts';
import { CHANGE_SOURCES } from '../../changes/registry.ts';
import type { ChangeEntry, ChangePoint, ChangeSourceDeps, RegisterTask, ResolvedPoint, TaskReader } from '../../changes/source.ts';
import { parseTypedInstant } from '../../core/time.ts';
import type { TimeZone } from '../../core/zone.ts';
import { RepoTokens } from '../../github/tokens.ts';
import type { Task } from '../../register/fold.ts';
import { noPositionals, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { openTeamKit, projectFolder, requireConfig, teamZone } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { ownRegister } from './register.ts';

/** At most this many of an entry's refs are shown beside it: its task, its issue and a commit say where to look. */
const SHOWN_REFS = 3;

/** A typed `--since` or `--until`: a version, else a time typed on the team's clock. */
function pointOf(flag: string, text: string, runtime: CliRuntime, zone: TimeZone): ChangePoint {
  const point = parsePoint(text, (typed) => parseTypedInstant(typed, runtime.clock.now(), zone));
  if (point === undefined) {
    throw new UsageError(`--${flag} takes a version (0.447.0) or a day or time (2026-11-16, 2026-11-16 09:00), not "${text}"`);
  }
  return point;
}

function registerTaskOf(task: Task): RegisterTask {
  return { id: task.id, title: task.title, type: task.type ?? 'task', ref: task.ref ?? undefined };
}

/** The team's register as the register source reads it: the working set, then its history for a task compacted away. */
function teamTasks(runtime: CliRuntime): TaskReader {
  return {
    tasks: async (ids) => {
      const { own } = await ownRegister(runtime);
      const working = own.snapshot.state.tasks;
      const missing = ids.some((id) => !working.has(id));
      const tasks = missing && own.snapshot.retired !== null ? (await own.history()).state.tasks : working;
      return ids.flatMap((id) => {
        const task = tasks.get(id);
        return task === undefined ? [] : [registerTaskOf(task)];
      });
    },
  };
}

function pointText(point: ResolvedPoint, zone: TimeZone): string {
  return point.version ?? (point.at === undefined ? 'the start' : zone.shortMinute(new Date(point.at)));
}

function entryLines(entry: ChangeEntry): string[] {
  const refs = entry.refs.slice(0, SHOWN_REFS);
  const head = `  ${entry.kind === 'action' ? 'ACTION' : entry.kind} ${entry.area}: ${entry.text.split('\n')[0] ?? ''}${refs.length === 0 ? '' : ` (${refs.join(' ')})`}`;
  return entry.action === undefined ? [head] : [head, `    do: ${entry.action}`];
}

/** The report as a reader scans it: one header per version with its day, its entries under it, then what could not be read. */
export function formatChanges(report: ChangesReport, zone: TimeZone): string[] {
  const range = `since ${pointText(report.since, zone)}${report.until === undefined ? '' : ` up to ${pointText(report.until, zone)}`}`;
  const lines = [`CHANGES ${range}: ${report.entries.length} change(s) from ${report.read.length === 0 ? 'no source' : report.read.join(', ')}`];
  let version: string | null = null;
  for (const entry of report.entries) {
    const shown = entry.version ?? '';
    if (shown !== version) {
      version = shown;
      const release = report.releases.find((candidate) => candidate.version === entry.version);
      lines.push(entry.version === undefined ? 'NOT RELEASED YET' : `${entry.version}${release === undefined ? '' : ` (${zone.day(new Date(release.at))})`}`);
    }
    lines.push(...entryLines(entry));
  }
  lines.push(...report.warnings.map((warning) => `WARN ${warning}`));
  lines.push(...report.failed.map((failed) => `FAILED ${failed.source}: ${failed.error}`));
  return lines;
}

/**
 * `changes --since <version|date> [--until <version|date>] [--file <path>] [--area <area>]`: what changed in the team's
 * project in that range, read from each change source the config names (`changes.sources`), else every one that applies.
 * A version the project never released is REFUSED with the ones it did; a source that fails is named beside the rest.
 */
export async function changes(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const config = requireConfig(await openTeamKit(runtime), runtime, 'read');
  const zone = teamZone(config, runtime);
  const since = pointOf('since', requiredFlag(args.flags, 'since'), runtime, zone);
  const untilText = args.flags.get('until');
  const tokens = new RepoTokens(runtime.credentials, runtime.env);
  const deps: ChangeSourceDeps = {
    files: runtime.files,
    git: runtime.changeGit,
    gh: runtime.gh,
    access: (repo) => tokens.accessFor(repo),
    project: await projectFolder(runtime, config),
    register: teamTasks(runtime),
  };
  const report = await readChanges(deps, CHANGE_SOURCES, {
    since,
    until: untilText === undefined ? undefined : pointOf('until', untilText, runtime, zone),
    file: args.flags.get('file'),
    area: args.flags.get('area'),
    sources: config.changes.sources.length === 0 ? 'auto' : config.changes.sources,
  });
  if (report.kind === 'unknown-version') {
    const known = report.known.slice(0, 10);
    throw new RefusedError(`the project has no release ${report.version}; ${known.length === 0 ? 'it has none: name a day instead' : `its newest: ${known.join(', ')}`}`);
  }
  if (report.kind === 'unknown-source') {
    throw new RefusedError(`changes.sources names "${report.source}", which this teamrig does not have; it has ${report.known.join(', ')}`);
  }
  for (const line of formatChanges(report, zone)) {
    runtime.out.stdout(line);
  }
  return EXIT.ok;
}
