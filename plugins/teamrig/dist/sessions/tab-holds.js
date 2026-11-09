import { join } from 'node:path';
import { isNonNegativeInteger, isRecord } from "../core/guards.js";
function isTime(value) {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
function isTabHold(value) {
    return (isRecord(value) &&
        typeof value['id'] === 'string' &&
        typeof value['team'] === 'string' &&
        typeof value['session'] === 'string' &&
        isNonNegativeInteger(value['needMb']) &&
        isNonNegativeInteger(value['needCommittedMb']) &&
        isTime(value['openedAt']) &&
        isTime(value['expiresAt']));
}
function parseHold(text) {
    try {
        const value = JSON.parse(text);
        return isTabHold(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
/** A hold's name, its id's; a writer's temporary sibling (`<name>.<pid>.<n>.tmp`) does not match. */
const HOLD_NAME = /^[^/\\]+\.json$/;
/** The folder of the tab holds beside the host lock at `hostLock`. */
export function tabHoldsDir(hostLock) {
    return `${hostLock}.tabs`;
}
/** The tab holds in `dir`, one file per hold (`<id>.json`), each written whole. */
export class TabHolds {
    dir;
    ports;
    constructor(dir, ports) {
        this.dir = dir;
        this.ports = ports;
    }
    /**
     * The holds still live, oldest first. One that ran out or cannot be read (a hold is written whole, so it is damaged)
     * is removed as it is found.
     */
    async live() {
        const { live, spent } = await this.read();
        for (const path of spent) {
            await this.ports.files.remove(path);
        }
        return live;
    }
    /** The holds still live, oldest first, removing none: for a report that changes nothing (`teamrig pipeline`). */
    async held() {
        return (await this.read()).live;
    }
    /** The live holds, oldest first, and the paths of those that ran out or cannot be read. */
    async read() {
        const { files, clock } = this.ports;
        const live = [];
        const spent = [];
        for (const name of (await files.list(this.dir)).filter((entry) => HOLD_NAME.test(entry))) {
            const path = join(this.dir, name);
            const text = await files.read(path);
            if (text === undefined) {
                continue;
            }
            const hold = parseHold(text);
            if (hold === undefined || Date.parse(hold.expiresAt) <= clock.now()) {
                spent.push(path);
            }
            else {
                live.push(hold);
            }
        }
        return { live: live.sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt)), spent };
    }
    async add(hold) {
        await this.ports.files.write(this.pathOf(hold.id), JSON.stringify(hold));
    }
    /** Removes the hold `id`, for a tab whose open failed; nothing when it is gone already. */
    async remove(id) {
        await this.ports.files.remove(this.pathOf(id));
    }
    pathOf(id) {
        return join(this.dir, `${id}.json`);
    }
}
