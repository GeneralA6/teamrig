import { isAbsolute, join } from 'node:path';
import { CLAIMS_FILE } from "./claims.js";
import { LEDGER_FILE, LEDGER_MD_FILE } from "./ledger.js";
/** The host lock's file name in the kit home, where every team on the host shares it. */
export const HOST_LOCK_FILE = 'host.lock';
/** A configured path as a place: a relative one is in the team's folder. */
export function teamPlace(paths, path) {
    return isAbsolute(path) ? path : join(paths.home, path);
}
/**
 * Where the coordinator's files are: the ledgers and quiet claims in `coordinator.dir` (default `<state>/deploys`), the host lock at
 * `coordinator.heavy.lockPath` (default the kit home's, one for the host). A relative path is in the team's folder.
 */
export function coordinatorPlaces(config, paths) {
    const inTeam = (path) => teamPlace(paths, path);
    const dir = config.dir === undefined ? join(paths.state, 'deploys') : inTeam(config.dir);
    return {
        ledger: join(dir, LEDGER_FILE),
        ledgerMd: join(dir, LEDGER_MD_FILE),
        claims: join(dir, CLAIMS_FILE),
        hostLock: config.heavy.lockPath === undefined ? join(paths.kitHome, HOST_LOCK_FILE) : inTeam(config.heavy.lockPath),
    };
}
