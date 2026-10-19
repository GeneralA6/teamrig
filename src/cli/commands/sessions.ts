import type { Roster } from '../../config/roster.ts';
import type { CommitCharge } from '../../coordinator/memory.ts';
import { KIT_NAME } from '../../core/home.ts';
import { measureSessions, type SessionPlace } from '../../sessions/measure.ts';
import { SessionRecordStore, type SessionRecord } from '../../sessions/record.ts';
import { UsageError, type ParsedArgs } from '../args.ts';
import { openTeamKit, requireConfig, rosterOf } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';

/** One session's line: `<id> <name>: ` and where it is. */
function placeLine(roster: Roster, place: SessionPlace): string {
  const where =
    place.state === 'running'
      ? `running in Claude Code ${place.claudePid}, ${place.treeMb} MB`
      : place.state === 'closed'
        ? 'closed: the Claude Code it last started in has ended'
        : 'no start recorded';
  return `${place.id} ${roster.nameOf(place.id) ?? place.id}: ${where}`;
}

function totalLine(places: readonly SessionPlace[]): string {
  const running = places.flatMap((place) => (place.state === 'running' ? [place.treeMb] : []));
  const closed = places.filter((place) => place.state === 'closed').length;
  const unrecorded = places.length - running.length - closed;
  const heldMb = running.reduce((total, mb) => total + mb, 0);
  return `${running.length} running hold ${heldMb} MB; ${closed} closed; ${unrecorded} with no start recorded`;
}

function hostLine(freeMb: number, commit: CommitCharge | undefined): string {
  const commitText = commit === undefined ? 'commit charge unknown on this system' : `commit ${commit.usedMb} of ${commit.limitMb} MB (${Math.round((commit.usedMb * 100) / commit.limitMb)}%)`;
  return `host: ${freeMb} MB free; ${commitText}`;
}

/**
 * `sessions`: each session, running (with the MB its Claude Code's process tree holds: helpers, shells, MCP
 * servers), closed or never recorded, then the host's free memory and commit charge. It only reads.
 */
export async function sessions(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const [extra] = args.positionals;
  if (extra !== undefined) {
    throw new UsageError(`unexpected "${extra}"`);
  }
  const kit = await openTeamKit(runtime);
  const roster = await rosterOf(runtime, kit, requireConfig(kit, runtime, 'read'));
  const store = new SessionRecordStore(runtime.files, kit.paths);
  const records = new Map(await Promise.all(roster.ids.map(async (id): Promise<[string, SessionRecord | undefined]> => [id, await store.read(id)])));
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
