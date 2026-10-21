import { isAbsolute, join } from 'node:path';
import type { TeamPaths } from '../core/home.ts';
import type { CoordinatorConfig } from '../config/types.ts';
import { CLAIMS_LOCK_FILE, CLAIMS_MD_FILE } from './claim-store.ts';
import { CLAIMS_FILE } from './claims.ts';
import { LEDGER_FILE, LEDGER_MD_FILE } from './ledger.ts';

/** The host lock's file name in the kit home, where every team on the host shares it. */
export const HOST_LOCK_FILE = 'host.lock';
/** The review holds' folder in `coordinator.dir`. */
export const REVIEW_HOLDS_DIR = 'review-holds';
/** The merges log's file name in `coordinator.dir`. */
export const MERGES_FILE = 'merges.jsonl';

/** The files the coordinator keeps. */
export interface CoordinatorPlaces {
  readonly ledger: string;
  readonly ledgerMd: string;
  readonly claims: string;
  readonly claimsMd: string;
  readonly claimsLock: string;
  readonly hostLock: string;
  /** The folder of the branches whose merge command waits, one file each (src/merge/pending-merges.ts). */
  readonly pendingMerges: string;
  /** The review gate's holds, one file per branch in flight (`ReviewHolds`). */
  readonly reviewHolds: string;
  /** What integrate landed under `pushToProtected: gated` (`MergeLog`). */
  readonly merges: string;
}

/** A configured path as a place: a relative one is in the team's folder. */
export function teamPlace(paths: Pick<TeamPaths, 'home'>, path: string): string {
  return isAbsolute(path) ? path : join(paths.home, path);
}

/** The coordinator's folder: `coordinator.dir`, a relative one in the team's folder; unset, `<state>/deploys`. */
export function coordinatorDirOf(config: Pick<CoordinatorConfig, 'dir'>, paths: Pick<TeamPaths, 'home' | 'state'>): string {
  return config.dir === undefined ? join(paths.state, 'deploys') : teamPlace(paths, config.dir);
}

/**
 * Where the coordinator's files are: the ledgers, the quiet claims and their lock, the pending merges, the review holds
 * and the merges log in `coordinator.dir` (default `<state>/deploys`); the host lock at `coordinator.heavy.lockPath`
 * (default the kit home's, one for the host). A relative path is in the team's folder.
 */
export function coordinatorPlaces(config: CoordinatorConfig, paths: TeamPaths): CoordinatorPlaces {
  const inTeam = (path: string): string => teamPlace(paths, path);
  const dir = coordinatorDirOf(config, paths);
  return {
    ledger: join(dir, LEDGER_FILE),
    ledgerMd: join(dir, LEDGER_MD_FILE),
    claims: join(dir, CLAIMS_FILE),
    claimsMd: join(dir, CLAIMS_MD_FILE),
    claimsLock: join(dir, CLAIMS_LOCK_FILE),
    hostLock: config.heavy.lockPath === undefined ? join(paths.kitHome, HOST_LOCK_FILE) : inTeam(config.heavy.lockPath),
    pendingMerges: join(dir, 'pending-merges'),
    reviewHolds: join(dir, REVIEW_HOLDS_DIR),
    merges: join(dir, MERGES_FILE),
  };
}
