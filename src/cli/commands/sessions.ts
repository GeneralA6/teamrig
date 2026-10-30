import type { Roster } from '../../config/roster.ts';
import type { CommitCharge } from '../../delivery/memory.ts';
import { KIT_NAME } from '../../core/home.ts';
import { measureSessions, runningPlaces, type SessionPlace } from '../../sessions/measure.ts';
import { SessionRecordStore } from '../../sessions/record.ts';
import { UsageError, type ParsedArgs } from '../args.ts';
import { idlePassOf, passLineOf, passTotalOf } from '../idle-pass.ts';
import { findTeam, openKit, openTeamKit, requireConfig, rosterOf, teamZone } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { sessionFoldersOf } from './setup.ts';

/** One session's line: `<id> <name>: ` and where it is. */
function placeLine(roster: Roster, place: SessionPlace): string {
  const where =
    place.state === 'running'
      ? `running in Claude Code ${place.claudePid}, ${place.treeMb} MB${committedText(place.committedMb)}`
      : place.state === 'closed'
        ? 'closed: the Claude Code it last started in has ended'
        : 'no start recorded';
  return `${place.id} ${roster.nameOf(place.id) ?? place.id}: ${where}`;
}

/** `, <MB> MB committed`, or nothing where the host does not say. */
function committedText(committedMb: number | undefined): string {
  return committedMb === undefined ? '' : `, ${committedMb} MB committed`;
}

/** The sum of `values`, or undefined when any is undefined. */
function sumOf(values: readonly (number | undefined)[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (value === undefined) {
      return undefined;
    }
    total += value;
  }
  return total;
}

function totalLine(places: readonly SessionPlace[]): string {
  const running = runningPlaces(places);
  const closed = places.filter((place) => place.state === 'closed').length;
  const unrecorded = places.length - running.length - closed;
  const heldMb = sumOf(running.map((place) => place.treeMb)) ?? 0;
  const committed = committedText(sumOf(running.map((place) => place.committedMb)));
  return `${running.length} running hold ${heldMb} MB${committed}; ${closed} closed; ${unrecorded} with no start recorded`;
}

function hostLine(freeMb: number, commit: CommitCharge | undefined): string {
  const commitText = commit === undefined ? 'commit charge unknown on this system' : `commit ${commit.usedMb} of ${commit.limitMb} MB (${Math.round((commit.usedMb * 100) / commit.limitMb)}%)`;
  return `host: ${freeMb} MB free; ${commitText}`;
}

/**
 * `sessions --pass [--project <dir>]`: what one idle pass would do with each session (T1100): close a running one
 * `teamrig close` would close, reopen one teamrig closed that the wake check would wake (one a pass, with room on
 * the host), and why it keeps or leaves the others. It only reads; `--project` is the folder the sessions' Claude
 * Code runs in, as for `close`.
 */
async function pass(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const found = await findTeam(runtime);
  const kit = await openKit(runtime, found.team);
  const config = requireConfig(kit, runtime, 'read');
  const roster = await rosterOf(runtime, kit, config);
  const steps = await idlePassOf(runtime, kit, config, roster, sessionFoldersOf(runtime, config, args.flags.get('project'), found.from));
  const zone = teamZone(config, runtime);
  steps.forEach((step) => runtime.out.stdout(passLineOf(step, roster, zone)));
  runtime.out.stdout(passTotalOf(steps));
  return EXIT.ok;
}

/**
 * `sessions`: each session, running (with the MB its Claude Code's process tree holds: helpers, shells, MCP
 * servers, and what it has committed where the host says), closed or never recorded, then the host's free memory
 * and commit charge; with `--pass`, what an idle pass would close and reopen. It only reads.
 */
export async function sessions(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const [extra] = args.positionals;
  if (extra !== undefined) {
    throw new UsageError(`unexpected "${extra}"`);
  }
  if (args.switches.has('pass')) {
    return pass(args, runtime);
  }
  if (args.flags.has('project')) {
    throw new UsageError('--project goes with --pass');
  }
  const kit = await openTeamKit(runtime);
  const roster = await rosterOf(runtime, kit, requireConfig(kit, runtime, 'read'));
  const records = await new SessionRecordStore(runtime.files, kit.paths).readEach(roster.ids);
  const [rows, commit] = await Promise.all([runtime.memory.processes(), runtime.memory.commit()]);
  if (rows === undefined) {
    runtime.out.stdout(`${KIT_NAME} could not list the host's processes, so it cannot tell which sessions run.`);
  } else {
    const places = measureSessions(records, rows);
    places.forEach((place) => runtime.out.stdout(placeLine(roster, place)));
    runtime.out.stdout(totalLine(places));
  }
  runtime.out.stdout(hostLine(runtime.memory.freeMb(), commit));
  return EXIT.ok;
}
