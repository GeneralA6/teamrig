import type { KitConfig } from '../config/types.ts';
import type { TeamPaths } from '../core/home.ts';
import { ADMIT_TTL_MS, AdmitFile } from '../delivery/admit-file.ts';
import { deliveryPlaces } from '../delivery/places.ts';
import { headroomFor, tabFloorOf, type Headroom } from '../sessions/headroom.ts';
import { measureSessions, runningPlaces } from '../sessions/measure.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import { TabHolds, tabHoldsDir } from '../sessions/tab-holds.ts';
import type { CliRuntime } from './runtime.ts';

type RoomConfig = Pick<KitConfig, 'delivery' | 'open'>;

/**
 * The host's room for one more session of a team whose sessions are `ids`: its free memory, its commit charge, what
 * each of them running holds and what every team's tabs still loading hold (kept beside the host lock, which every
 * team shares). One process listing and one commit read, about a second each on Windows.
 */
export async function headroomOf(runtime: CliRuntime, paths: TeamPaths, config: RoomConfig, ids: readonly string[]): Promise<Headroom> {
  const records = await new SessionRecordStore(runtime.files, paths).readEach(ids);
  const [rows, commit, loading] = await Promise.all([runtime.memory.processes(), runtime.memory.commit(), tabHoldsOf(runtime, paths, config).live()]);
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

function hostLockOf(paths: TeamPaths, config: RoomConfig): string {
  return deliveryPlaces(config.delivery, paths).hostLock;
}

function tabHoldsOf(runtime: CliRuntime, paths: TeamPaths, config: RoomConfig): TabHolds {
  return new TabHolds(tabHoldsDir(hostLockOf(paths, config)), runtime);
}

/** How long a tab's admission waits between looks while another admission holds the host's admit file. */
const ADMIT_POLL_MS = 1_000;

/** How long a tab's admission waits for the admit file: a live claim runs out within `ADMIT_TTL_MS`. */
export const ADMIT_WAIT_MS = ADMIT_TTL_MS + ADMIT_POLL_MS;

/** One tab about to open: its session, and whether it opens whatever the room (the lead, which decides which others run). */
export interface TabToOpen {
  readonly session: string;
  readonly anyRoom: boolean;
}

/**
 * A tab's admission: `admitted` with the hold written for it while it loads (`holdId`), `no-room` with the room it
 * lacks, or `busy` when other admissions held the host's admit file for all of `ADMIT_WAIT_MS`.
 */
export type TabAdmission =
  | { readonly kind: 'admitted'; readonly holdId: string }
  | { readonly kind: 'no-room'; readonly headroom: Headroom }
  | { readonly kind: 'busy' };

/**
 * Admits one tab: under the host's admit file, which queued steps take too, so no tab or step reads the room another
 * just took as free, it reads the host's room and, where the tab fits (or opens whatever the room), writes a hold of
 * what the tab was counted at for `open.headroom.loadMinutes`, so every team's next admission counts the tab before
 * free memory shows it. A tab that opens whatever the room still waits for the file, and opens without it once the
 * wait is over.
 */
export async function admitTab(runtime: CliRuntime, paths: TeamPaths, config: RoomConfig, ids: readonly string[], tab: TabToOpen): Promise<TabAdmission> {
  const { files, clock, pid, sessionProcesses } = runtime;
  const admit = new AdmitFile(`${hostLockOf(paths, config)}.admit`, { files, clock, pid, alive: (other) => sessionProcesses.alive(other) });
  const holdId = runtime.newId();
  const claim = await claimWithin(runtime, admit, holdId);
  if (claim === undefined && !tab.anyRoom) {
    return { kind: 'busy' };
  }
  try {
    const headroom = await headroomOf(runtime, paths, config, ids);
    if (headroom.short.length > 0 && !tab.anyRoom) {
      return { kind: 'no-room', headroom };
    }
    const openedAt = clock.now();
    await tabHoldsOf(runtime, paths, config).add({
      id: holdId,
      team: paths.team,
      session: tab.session,
      needMb: headroom.needMb,
      needCommittedMb: headroom.needCommittedMb,
      openedAt: new Date(openedAt).toISOString(),
      expiresAt: new Date(openedAt + config.open.headroom.loadMinutes * 60_000).toISOString(),
    });
    return { kind: 'admitted', holdId };
  } finally {
    if (claim !== undefined) {
      await admit.release(claim);
    }
  }
}

/** The admit file's claim for `id`, looked for once a second for `ADMIT_WAIT_MS`; undefined if it stayed held. */
async function claimWithin(runtime: CliRuntime, admit: AdmitFile, id: string): Promise<string | undefined> {
  const deadline = runtime.clock.now() + ADMIT_WAIT_MS;
  for (;;) {
    const claim = await admit.claim(id);
    if (claim !== undefined || runtime.clock.now() >= deadline) {
      return claim;
    }
    await runtime.sleep(ADMIT_POLL_MS);
  }
}

/** Removes the hold of a tab that did not open, so the room it was counted at is free again at once. */
export async function dropTabHold(runtime: CliRuntime, paths: TeamPaths, config: RoomConfig, holdId: string): Promise<void> {
  await tabHoldsOf(runtime, paths, config).remove(holdId);
}

/** Why `what` waits: other admissions held the host's admit file for all of the wait. */
export function admitBusyText(what: string): string {
  return `the host's room could not be read to ${what}: other tabs and queued steps were being admitted for all of ${ADMIT_WAIT_MS / 1000} s; try again`;
}
