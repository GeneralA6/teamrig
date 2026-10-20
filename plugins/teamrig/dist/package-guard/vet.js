import { errorMessage } from "../core/guards.js";
/**
 * Vets the packages an install names against the registry: each exact version, or the version its dist-tag points
 * at, must be published at least `cooldownDays` ago and have no known advisory. A registry that cannot be asked in
 * time vouches for nothing, so the install is not vetted.
 */
const DAY_MS = 86_400_000;
function resolutionOf(target, doc) {
    if (doc === undefined) {
        return { kind: 'problem', why: 'not on the registry' };
    }
    const { wanted } = target;
    const version = wanted.kind === 'version' ? wanted.version : doc.distTags.get(wanted.tag);
    if (version === undefined) {
        return { kind: 'problem', why: `${target.name} has no "${wanted.kind === 'tag' ? wanted.tag : ''}" tag` };
    }
    return { kind: 'version', version, publishedAt: doc.published.get(version) };
}
function daysText(days) {
    return `${days} day${days === 1 ? '' : 's'}`;
}
/** Why each target the registry is asked about is not vetted: not there, too young, or with an advisory. */
async function registryProblems(targets, ports, cooldownDays, signal) {
    const names = [...new Set(targets.map((target) => target.name))];
    const docs = new Map(await Promise.all(names.map(async (name) => [name, await ports.registry.packageDoc(name, signal)])));
    const now = ports.clock.now();
    const problems = [];
    const versions = new Map();
    for (const target of targets) {
        const resolution = resolutionOf(target, docs.get(target.name));
        if (resolution.kind === 'problem') {
            problems.push(`${target.spec}: ${resolution.why}`);
            continue;
        }
        const { version, publishedAt } = resolution;
        const shown = `${target.name}@${version}`;
        if (publishedAt === undefined) {
            problems.push(`${shown}: not a published version`);
            continue;
        }
        if (now - publishedAt < cooldownDays * DAY_MS) {
            const age = daysText(Math.max(0, Math.floor((now - publishedAt) / DAY_MS)));
            problems.push(`${shown}: published ${age} ago (${new Date(publishedAt).toISOString().slice(0, 10)}), inside the ${cooldownDays}-day cooldown`);
        }
        versions.set(target.name, (versions.get(target.name) ?? new Set()).add(version));
    }
    if (versions.size > 0) {
        const asked = new Map([...versions].map(([name, set]) => [name, [...set]]));
        for (const advisory of await ports.registry.advisories(asked, signal)) {
            const link = advisory.url === '' ? '' : ` (${advisory.url})`;
            problems.push(`${advisory.name}@${(asked.get(advisory.name) ?? []).join(', ')}: a ${advisory.severity} advisory, ${advisory.title}${link}`);
        }
    }
    return problems;
}
/**
 * Runs `work` with a signal that aborts after `timeoutMs`. Its timer holds the process open, unlike
 * `AbortSignal.timeout`'s, so the deadline fires even while nothing else is pending, and it is cleared once `work` ends.
 */
async function withDeadline(timeoutMs, work) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs);
    try {
        return await work(controller.signal);
    }
    finally {
        clearTimeout(timer);
    }
}
/** Why each target is not vetted, one line each; empty when the registry vouches for every one. */
export async function unvettedOf(targets, ports, limits) {
    const lines = targets.flatMap((target) => (target.kind === 'unvetted' ? [`${target.spec}: ${target.why}`] : []));
    const asks = targets.filter((target) => target.kind === 'registry');
    if (asks.length === 0) {
        return lines;
    }
    try {
        return [...lines, ...(await withDeadline(limits.timeoutMs, (signal) => registryProblems(asks, ports, limits.cooldownDays, signal)))];
    }
    catch (error) {
        const names = [...new Set(asks.map((target) => target.name))].join(', ');
        return [...lines, `${names}: the registry could not be asked (${errorMessage(error)}), so nothing vouches for it`];
    }
}
