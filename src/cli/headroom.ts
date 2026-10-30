import type { KitConfig } from '../config/types.ts';
import type { TeamPaths } from '../core/home.ts';
import { headroomFor, type Headroom } from '../sessions/headroom.ts';
import { measureSessions, runningPlaces } from '../sessions/measure.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import type { CliRuntime } from './runtime.ts';

/**
 * The host's room for one more session of a team whose sessions are `ids`: its free memory, its commit charge and
 * what each of them running holds. One process listing and one commit read, about a second each on Windows.
 */
export async function headroomOf(
  runtime: CliRuntime,
  paths: Pick<TeamPaths, 'sessions'>,
  config: Pick<KitConfig, 'delivery' | 'open'>,
  ids: readonly string[],
): Promise<Headroom> {
  const records = await new SessionRecordStore(runtime.files, paths).readEach(ids);
  const [rows, commit] = await Promise.all([runtime.memory.processes(), runtime.memory.commit()]);
  const running = rows === undefined ? [] : runningPlaces(measureSessions(records, rows));
  const room = {
    freeMb: runtime.memory.freeMb(),
    commit,
    runningMb: running.map((place) => place.treeMb),
    runningCommittedMb: running.flatMap((place) => (place.committedMb === undefined ? [] : [place.committedMb])),
  };
  return headroomFor(room, config.delivery.queue.memoryFloorMb, config.open.headroom);
}
