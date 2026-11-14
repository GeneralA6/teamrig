import { dirname, isAbsolute, join } from 'node:path';
import { CLAIMS_LOCK_FILE, CLAIMS_MD_FILE } from "./freeze-store.js";
import { CLAIMS_FILE } from "./freezes.js";
import { LEDGER_FILE, LEDGER_MD_FILE } from "./ledger.js";
import { PIPELINE_FREEZES_FILE, PIPELINE_FREEZES_LOCK_FILE } from "./pipeline-freezes.js";
/** The host lock's file name in the kit home, where every team on the host shares it. */
export const HOST_LOCK_FILE = 'host.lock';
/** The review holds' folder in `delivery.dir`. */
export const REVIEW_HOLDS_DIR = 'review-holds';
/** The gate holds' folder in `delivery.dir`. */
export const GATE_HOLDS_DIR = 'gate-holds';
/** The merges log's file name in `delivery.dir`. */
export const MERGES_FILE = 'merges.jsonl';
/** The folder in `delivery.dir` of the logs of the steps `teamrig queue --detach` started, one per run. */
export const DETACHED_DIR = 'detached';
/** A configured path as a place: a relative one is in the team's folder. */
export function teamPlace(paths, path) {
    return isAbsolute(path) ? path : join(paths.home, path);
}
/** The delivery folder: `delivery.dir`, a relative one in the team's folder; unset, `<state>/deploys`. */
export function deliveryDirOf(config, paths) {
    return config.dir === undefined ? join(paths.state, 'deploys') : teamPlace(paths, config.dir);
}
/** The folder of the detached queue runs' logs and records (detached-runs.ts). */
export function detachedDirOf(config, paths) {
    return join(deliveryDirOf(config, paths), DETACHED_DIR);
}
/** The log of the detached queue run `id`: its step's output, and the queue's own lines, since no shell waits for them. */
export function detachedLogOf(config, paths, id) {
    return join(detachedDirOf(config, paths), `${id}.log`);
}
/**
 * Where the delivery files are: the ledgers, the deploy freezes and their lock, the pending merges, the review and
 * gate holds and the merges log in `delivery.dir` (default `<state>/deploys`); the host lock at
 * `delivery.queue.lockPath` (default the kit home's, one for the host), and the pipeline freezes and their lock beside
 * it. A relative path is in the team's folder.
 */
export function deliveryPlaces(config, paths) {
    const inTeam = (path) => teamPlace(paths, path);
    const dir = deliveryDirOf(config, paths);
    const hostLock = config.queue.lockPath === undefined ? join(paths.kitHome, HOST_LOCK_FILE) : inTeam(config.queue.lockPath);
    return {
        ledger: join(dir, LEDGER_FILE),
        ledgerMd: join(dir, LEDGER_MD_FILE),
        freezes: join(dir, CLAIMS_FILE),
        freezesMd: join(dir, CLAIMS_MD_FILE),
        freezesLock: join(dir, CLAIMS_LOCK_FILE),
        hostLock,
        pipelineFreezes: join(dirname(hostLock), PIPELINE_FREEZES_FILE),
        pipelineFreezesLock: join(dirname(hostLock), PIPELINE_FREEZES_LOCK_FILE),
        pendingMerges: join(dir, 'pending-merges'),
        reviewHolds: join(dir, REVIEW_HOLDS_DIR),
        gateHolds: join(dir, GATE_HOLDS_DIR),
        merges: join(dir, MERGES_FILE),
    };
}
