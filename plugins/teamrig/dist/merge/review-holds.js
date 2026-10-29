import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isReviewClass } from "../config/types.js";
import { isRecord, recordField, stringField } from "../core/guards.js";
/** The hold's id: the same change always gets the same one. */
export function holdId(change) {
    const { repo, branch, base, head, tree } = change;
    return `H${createHash('sha256').update([repo, branch, base, head, tree].join('\0')).digest('hex').slice(0, 12)}`;
}
/** Whether the hold binds this very change: the same commits on the same branch, making the same tree. */
export function holdBinds(hold, change) {
    return hold.repo === change.repo && hold.branch === change.branch && hold.base === change.base && hold.head === change.head && hold.tree === change.tree;
}
/** Reads and writes the holds in one folder. */
export class ReviewHolds {
    files;
    dir;
    constructor(files, dir) {
        this.files = files;
        this.dir = dir;
    }
    /** The branch's hold; undefined when it has none or its file does not read as one, which a new hold replaces. */
    async read(repo, branch) {
        return parseHold(await this.files.read(this.pathOf(repo, branch)));
    }
    async write(hold) {
        await this.files.write(this.pathOf(hold.repo, hold.branch), `${JSON.stringify(storedHold(hold), null, 2)}\n`);
    }
    /** Removes the branch's hold once it landed: true when it had one. */
    async remove(repo, branch) {
        return this.files.remove(this.pathOf(repo, branch));
    }
    pathOf(repo, branch) {
        return join(this.dir, `${encodeURIComponent(repo)}~${encodeURIComponent(branch)}.json`);
    }
}
function storedHold(hold) {
    return {
        ...hold,
        reviewer: { who: hold.reviewer.who, fallback: hold.reviewer.fallback ?? null },
        hits: hold.hits.map(({ path, glob }) => ({ path, glob })),
        findings: hold.findings ?? null,
    };
}
const HOLD_TEXT_FIELDS = ['id', 'repo', 'branch', 'base', 'head', 'tree', 'task', 'session', 'createdAt'];
function parseHold(text) {
    if (text === undefined) {
        return undefined;
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (!isRecord(value)) {
        return undefined;
    }
    const [id, repo, branch, base, head, tree, task, session, createdAt] = HOLD_TEXT_FIELDS.map((key) => stringField(value, key));
    const holdClass = value['holdClass'];
    const reviewer = parseReviewer(recordField(value, 'reviewer'));
    const hits = parseHits(value['hits']);
    const findings = value['findings'];
    if (id === undefined ||
        repo === undefined ||
        branch === undefined ||
        base === undefined ||
        head === undefined ||
        tree === undefined ||
        task === undefined ||
        session === undefined ||
        createdAt === undefined ||
        !isReviewClass(holdClass) ||
        reviewer === undefined ||
        hits === undefined ||
        (findings !== null && typeof findings !== 'string')) {
        return undefined;
    }
    return { id, repo, branch, base, head, tree, task, session, holdClass, reviewer, hits, findings: findings ?? undefined, createdAt };
}
function parseReviewer(record) {
    const who = record === undefined ? undefined : stringField(record, 'who');
    const fallback = record?.['fallback'];
    if (who === undefined || (fallback !== null && typeof fallback !== 'string')) {
        return undefined;
    }
    return { who, fallback: fallback ?? undefined };
}
function parseHits(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const hits = [];
    for (const item of value) {
        const path = isRecord(item) ? stringField(item, 'path') : undefined;
        const glob = isRecord(item) ? stringField(item, 'glob') : undefined;
        if (path === undefined || glob === undefined) {
            return undefined;
        }
        hits.push({ path, glob });
    }
    return hits;
}
