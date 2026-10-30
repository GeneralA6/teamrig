import { isAbsolute, join } from 'node:path';
import { CLAIMS_LOCK_FILE, CLAIMS_MD_FILE } from "./freeze-store.js";
import { CLAIMS_FILE } from "./freezes.js";
import { LEDGER_FILE, LEDGER_MD_FILE } from "./ledger.js";
/** The host lock's file name in the kit home, where every team on the host shares it. */
export const HOST_LOCK_FILE = 'host.lock';
/** The review holds' folder in `delivery.dir`. */
export const REVIEW_HOLDS_DIR = 'review-holds';
/** The gate holds' folder in `delivery.dir`. */
export const GATE_HOLDS_DIR = 'gate-holds';
/** The merges log's file name in `delivery.dir`. */
export const MERGES_FILE = 'merges.jsonl';
/** A configured path as a place: a relative one is in the team's folder. */
export function teamPlace(paths, path) {
    return isAbsolute(path) ? path : join(paths.home, path);
}
/** The delivery folder: `delivery.dir`, a relative one in the team's folder; unset, `<state>/deploys`. */
export function deliveryDirOf(config, paths) {
    return config.dir === undefined ? join(paths.state, 'deploys') : teamPlace(paths, config.dir);
}
/**
 * Where the delivery files are: the ledgers, the deploy freezes and their lock, the pending merges, the review and
 * gate holds and the merges log in `delivery.dir` (default `<state>/deploys`); the host lock at
 * `delivery.queue.lockPath` (default the kit home's, one for the host). A relative path is in the team's folder.
 */
export function deliveryPlaces(config, paths) {
    const inTeam = (path) => teamPlace(paths, path);
    const dir = deliveryDirOf(config, paths);
    return {
        ledger: join(dir, LEDGER_FILE),
        ledgerMd: join(dir, LEDGER_MD_FILE),
        freezes: join(dir, CLAIMS_FILE),
        freezesMd: join(dir, CLAIMS_MD_FILE),
        freezesLock: join(dir, CLAIMS_LOCK_FILE),
        hostLock: config.queue.lockPath === undefined ? join(paths.kitHome, HOST_LOCK_FILE) : inTeam(config.queue.lockPath),
        pendingMerges: join(dir, 'pending-merges'),
        reviewHolds: join(dir, REVIEW_HOLDS_DIR),
        gateHolds: join(dir, GATE_HOLDS_DIR),
        merges: join(dir, MERGES_FILE),
    };
}
