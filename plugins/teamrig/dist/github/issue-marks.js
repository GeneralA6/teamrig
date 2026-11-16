import { managedLabel } from "../issues/managed-labels.js";
import { issueRef } from "./map.js";
/**
 * The label and close or reopen news of the issues a task holds or a session follows (github.activity), kept pure:
 * the mark a sync keeps of each between runs (`issueMarkOf`), what changed since (`issueChanges`), who hears it
 * (`issueMarkStep`) and the line (`issueChangeLine`). It reads only what the issue read already has, so it costs no
 * GitHub call. An issue seen for the first time is only marked, so a new follow, a new task or the feature turned on
 * tells nothing of the past. teamrig's own labels (managed-labels.ts) and a label one of ours put on last are never
 * told: the team made them.
 */
/** Issue changes one line names; the rest are counted. */
const NAMED_CHANGES = 8;
export function issueMarkOf(issue) {
    return { open: issue.state === 'open', labels: [...new Set(issue.labels)].filter((label) => managedLabel(label) === undefined).sort() };
}
/**
 * What changed from `before` to `issue`: `closed` or `reopened` (undefined when neither), and each label put on, then
 * each taken off. A label whose newest put-on event is by one of ours or by the key itself is left out.
 */
export function issueChanges(before, issue, routing) {
    const now = issueMarkOf(issue);
    const state = before.open === now.open ? undefined : now.open ? 'reopened' : 'closed';
    const put = now.labels.filter((label) => !before.labels.includes(label) && !putByUs(issue, label, routing)).map((label) => `labelled ${JSON.stringify(label)}`);
    const taken = before.labels.filter((label) => !now.labels.includes(label)).map((label) => `unlabelled ${JSON.stringify(label)}`);
    return { state, labels: [...put, ...taken] };
}
function putByUs(issue, label, routing) {
    const newest = issue.labelEvents.filter((event) => event.label === label).reduce((last, event) => (last === undefined || Date.parse(event.at) >= Date.parse(last.at) ? event : last), undefined);
    const actor = newest?.actor.toLowerCase() ?? '';
    return actor !== '' && (routing.ours.has(actor) || actor === routing.self?.toLowerCase());
}
function watched(audience) {
    return audience.owner !== undefined || audience.followers.length > 0;
}
/**
 * One run's issue news of `repo` against its marks, and the marks after. Only a watched issue is marked. Its task's
 * owner hears a close only while the task is not finished and a reopen only once it is, so a close the owner made by
 * finishing its task is no news; a follower hears each. A watched issue this run did not read (closed before
 * `closedDays`) keeps its mark, so a reopen is still news; an issue no longer watched is dropped.
 */
export function issueMarkStep(repo, issues, before, audienceOf, routing) {
    const after = new Map();
    const routes = [];
    for (const issue of issues) {
        const audience = audienceOf(issue.number);
        if (!watched(audience)) {
            continue;
        }
        after.set(issue.number, issueMarkOf(issue));
        const last = before.get(issue.number);
        if (last === undefined) {
            continue;
        }
        const { state, labels } = issueChanges(last, issue, routing);
        const ref = issueRef(repo, issue.number);
        const told = new Set();
        const tell = (to, changes) => {
            if (!told.has(to) && changes.length > 0) {
                routes.push({ to, ref, changes });
            }
            told.add(to);
        };
        if (audience.owner !== undefined) {
            const news = state !== undefined && (state === 'closed') !== audience.owner.finished;
            tell(audience.owner.to, [...(news ? [state] : []), ...labels]);
        }
        audience.followers.forEach((to) => tell(to, [...(state === undefined ? [] : [state]), ...labels]));
    }
    for (const [number, mark] of before) {
        if (!after.has(number) && !issues.some((issue) => issue.number === number) && watched(audienceOf(number))) {
            after.set(number, mark);
        }
    }
    return { routes, after };
}
/** One session's line for its issue news, by session in the order first seen. */
export function issueRoutesBySession(routes) {
    const bySession = new Map();
    for (const route of routes) {
        bySession.set(route.to, [...(bySession.get(route.to) ?? []), route]);
    }
    return bySession;
}
/** A session's line: each issue's changes, at most NAMED_CHANGES issues, then how many more. */
export function issueChangeLine(routes) {
    const named = routes.slice(0, NAMED_CHANGES).map((route) => `${route.ref} ${route.changes.join(', ')}`);
    const more = routes.length - named.length;
    return `GitHub issue changes: ${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
}
