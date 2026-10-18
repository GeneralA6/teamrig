import { isAbsolute, join } from 'node:path';
import type { TeamPaths } from '../core/home.ts';
import type { CoordinatorConfig } from '../config/types.ts';
import { LEDGER_FILE } from './ledger.ts';

/** The host lock's file name in the kit home, where every team on the host shares it. */
export const HOST_LOCK_FILE = 'host.lock';

/** The files the coordinator keeps. */
export interface CoordinatorPlaces {
  readonly ledger: string;
  readonly hostLock: string;
}

/**
 * Where the coordinator's files are: the ledger in `coordinator.dir` (default `<state>/deploys`), the host lock at
 * `coordinator.heavy.lockPath` (default the kit home's, one for the host). A relative path is in the team's folder.
 */
export function coordinatorPlaces(config: CoordinatorConfig, paths: TeamPaths): CoordinatorPlaces {
  const inTeam = (path: string): string => (isAbsolute(path) ? path : join(paths.home, path));
  const dir = config.dir === undefined ? join(paths.state, 'deploys') : inTeam(config.dir);
  return {
    ledger: join(dir, LEDGER_FILE),
    hostLock: config.heavy.lockPath === undefined ? join(paths.kitHome, HOST_LOCK_FILE) : inTeam(config.heavy.lockPath),
  };
}
