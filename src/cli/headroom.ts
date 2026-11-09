import type { KitConfig } from '../config/types.ts';
import type { TeamPaths } from '../core/home.ts';
import { deliveryPlaces } from '../delivery/places.ts';
import { headroomFor, tabFloorOf, type Headroom } from '../sessions/headroom.ts';
import { measureSessions, runningPlaces } from '../sessions/measure.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import { TabHolds, tabHoldsDir } from '../sessions/tab-holds.ts';
import type { CliRuntime } from './runtime.ts';

/**
 * The host's room for one more session of a team whose sessions are `ids`: its free memory, its commit charge, what
 * each of them running holds and what every team's tabs still loading hold (kept beside the host lock, which every
 * team shares). One process listing and one commit read, about a second each on Windows.
 */
export async function headroomOf(
  runtime: CliRuntime,
  paths: TeamPaths,
  config: Pick<KitConfig, 'delivery' | 'open'>,
  ids: readonly string[],
): Promise<Headroom> {
  const records = await new SessionRecordStore(runtime.files, paths).readEach(ids);
  const holds = new TabHolds(tabHoldsDir(deliveryPlaces(config.delivery, paths).hostLock), runtime);
  const [rows, commit, loading] = await Promise.all([runtime.memory.processes(), runtime.memory.commit(), holds.live()]);
  const running = rows === undefined ? [] : runningPlaces(measureSessions(records, rows));
  const room = {
    freeMb: runtime.memory.freeMb(),
    commit,
    runningMb: running.map((place) => place.treeMb),
    runningCommittedMb: running.flatMap((place) => (place.committedMb === undefined ? [] : [place.committedMb])),
    loading,
  };
  return headroomFor(room, tabFloorOf(config.open.headroom, config.delivery.queue), config.open.headroom);
}
