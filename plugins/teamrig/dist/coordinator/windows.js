const MINUTE_MS = 60_000;
function isDeploy(record) {
    return record.type === 'deploy';
}
function isHeavy(record) {
    return record.type === 'heavy';
}
function isLoad(record) {
    return record.type === 'load';
}
function touches(targets, target) {
    return targets === 'host' || targets.includes(target);
}
/**
 * The deploys and heavy steps of the ledger as disruptions. A deploy comes from its ledger.md line, which a session
 * may write by hand; a deploy record of the same session and repository in the same minute gives its real start, else
 * it is taken to have rolled for `assumedRollMs`. It disturbs its repository's targets until `settleMs` after it
 * rolled. A heavy step loads the whole host. One with no end record is still running, or was killed before it could
 * write one: it ends at the first of now, the next heavy step's start (the host lock is exclusive, so it was free by
 * then) and its start plus the lock's time to live.
 */
export function disruptions(input) {
    const deploys = input.records.filter(isDeploy);
    const fromDeploys = input.md.map((line) => {
        const minute = Math.floor(line.rolledAt / MINUTE_MS);
        const twin = deploys.find((record) => record.session === line.session && record.repo === line.repo && Math.floor(Date.parse(record.rolledAt) / MINUTE_MS) === minute);
        return {
            from: twin === undefined ? line.rolledAt - input.assumedRollMs : Date.parse(twin.startedAt),
            to: line.rolledAt + input.settleMs,
            targets: input.targetsOf(line.repo),
        };
    });
    const steps = input.records.filter(isHeavy);
    const starts = steps.map((step) => Date.parse(step.startedAt));
    const byId = new Map();
    for (const step of steps) {
        if (byId.has(step.id) && step.endedAt === null) {
            continue;
        }
        const from = Date.parse(step.startedAt);
        byId.set(step.id, { from, to: step.endedAt === null ? unfinishedEnd(from, starts, input) : Date.parse(step.endedAt), targets: 'host' });
    }
    return [...fromDeploys, ...byId.values()];
}
function unfinishedEnd(from, starts, input) {
    return starts.reduce((end, start) => (start > from && start < end ? start : end), Math.min(input.nowMs, from + input.lockTtlMs));
}
/** One load per id, its end record winning; one with no end record runs until now. */
export function loadsOf(records, nowMs) {
    const byId = new Map();
    for (const record of records.filter(isLoad)) {
        if (byId.has(record.id) && record.endedAt === null) {
            continue;
        }
        byId.set(record.id, {
            id: record.id,
            session: record.session,
            what: record.what,
            targets: record.targets,
            from: Date.parse(record.startedAt),
            to: record.endedAt === null ? nowMs : Date.parse(record.endedAt),
            open: record.endedAt === null,
        });
    }
    return [...byId.values()];
}
/** The loads on `target` that overlap `span`. */
export function loadsDuring(loads, target, span) {
    return loads.filter((load) => touches(load.targets, target) && load.to > span.from && load.from < span.to);
}
/** The parts of `span` that no disruption of `target` covers, each at least `minMs` long. */
export function cleanWindows(all, target, span, minMs) {
    const relevant = all.filter((disruption) => touches(disruption.targets, target) && disruption.to > span.from && disruption.from < span.to).sort((a, b) => a.from - b.from);
    const found = [];
    let cursor = span.from;
    for (const disruption of relevant) {
        if (disruption.from > cursor) {
            found.push({ from: cursor, to: disruption.from });
        }
        cursor = Math.max(cursor, disruption.to);
    }
    if (cursor < span.to) {
        found.push({ from: cursor, to: span.to });
    }
    return found.filter((window) => window.to - window.from >= minMs);
}
