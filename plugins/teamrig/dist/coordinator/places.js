import { isAbsolute, join } from 'node:path';
import { LEDGER_FILE } from "./ledger.js";
/** The host lock's file name in the kit home, where every team on the host shares it. */
export const HOST_LOCK_FILE = 'host.lock';
/**
 * Where the coordinator's files are: the ledger in `coordinator.dir` (default `<state>/deploys`), the host lock at
 * `coordinator.heavy.lockPath` (default the kit home's, one for the host). A relative path is in the team's folder.
 */
export function coordinatorPlaces(config, paths) {
    const inTeam = (path) => (isAbsolute(path) ? path : join(paths.home, path));
    const dir = config.dir === undefined ? join(paths.state, 'deploys') : inTeam(config.dir);
    return {
        ledger: join(dir, LEDGER_FILE),
        hostLock: config.heavy.lockPath === undefined ? join(paths.kitHome, HOST_LOCK_FILE) : inTeam(config.heavy.lockPath),
    };
}
