import { join } from 'node:path';
import { isRecord, stringField } from "../core/guards.js";
import { changeHash } from "./review-holds.js";
import { isSelfMergeGate } from "./self-merge.js";
/** The hold's id: the same change always gets the same one. */
export function gateHoldId(change) {
    return `G${changeHash(change)}`;
}
/** Reads and writes the holds in one folder. */
export class GateHolds {
    files;
    dir;
    constructor(files, dir) {
        this.files = files;
        this.dir = dir;
    }
    /** The branch's hold; undefined when it has none or its file does not read as one, which a new hold replaces. */
    async read(repo, branch) {
        return parseGateHold(await this.files.read(this.pathOf(repo, branch)));
    }
    async write(hold) {
        await this.files.write(this.pathOf(hold.repo, hold.branch), `${JSON.stringify(hold, null, 2)}\n`);
    }
    /** Removes the branch's hold once it landed: true when it had one. */
    async remove(repo, branch) {
        return this.files.remove(this.pathOf(repo, branch));
    }
    pathOf(repo, branch) {
        return join(this.dir, `${encodeURIComponent(repo)}~${encodeURIComponent(branch)}.json`);
    }
}
const HOLD_TEXT_FIELDS = ['id', 'repo', 'branch', 'base', 'head', 'tree', 'task', 'session', 'reviewer', 'createdAt'];
function parseMiss(value) {
    const gate = isRecord(value) ? value['gate'] : undefined;
    const why = isRecord(value) ? stringField(value, 'why') : undefined;
    return isSelfMergeGate(gate) && why !== undefined ? { gate, why } : undefined;
}
function parseMisses(value) {
    if (!Array.isArray(value) || value.length === 0) {
        return undefined;
    }
    const misses = value.map(parseMiss);
    return misses.every((miss) => miss !== undefined) ? misses : undefined;
}
export function parseGateHold(text) {
    let value;
    try {
        value = text === undefined ? undefined : JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (!isRecord(value)) {
        return undefined;
    }
    const record = value;
    const [id, repo, branch, base, head, tree, task, session, reviewer, createdAt] = HOLD_TEXT_FIELDS.map((key) => stringField(record, key));
    const misses = parseMisses(record['misses']);
    if (id === undefined ||
        repo === undefined ||
        branch === undefined ||
        base === undefined ||
        head === undefined ||
        tree === undefined ||
        task === undefined ||
        session === undefined ||
        reviewer === undefined ||
        createdAt === undefined ||
        misses === undefined) {
        return undefined;
    }
    return { id, repo, branch, base, head, tree, task, session, reviewer, misses, createdAt };
}
