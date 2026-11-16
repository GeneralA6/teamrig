import { MENTION_PAGE_SIZE, MENTION_PAGES_MAX } from "./gh.js";
import { areaOwnerOf, issueRef } from "./map.js";
import { mentionsOf } from "./mentions.js";
import { REVIEW_READS_MAX } from "./posts.js";
import { ownBranchTask } from "./pull-news.js";
/**
 * Where a mention of one of our users goes, kept pure: which posts' mentions are new since the last read
 * (`mentionRoutes`, against the logins each post already routed), the session each goes to, whether it wakes it
 * (`wakeRoutes`, at most once per item per MENTION_WAKE_GAP_MINUTES) and the inbox line it gets (`mentionLine`).
 */
/** A session is woken for mentions on one issue or pull request at most once in this many minutes; the rest wait. */
export const MENTION_WAKE_GAP_MINUTES = 30;
/**
 * The session a mention of `login` on an item goes to: the owner of the task holding the item; else the area owner
 * by its labels; else the session `github.owners` maps the login to; else the watcher.
 */
export function mentionRecipient(item, login, routing) {
    return item.taskOwner ?? areaOwnerOf(item.labels, routing.rules.areaOwners) ?? routing.rules.owners.get(login) ?? routing.watcher;
}
/**
 * The routes of a repository's posts read this run, and the seen marks after them. A post by one of ours or by the
 * key itself routes nothing; a login a post already routed routes nothing again (an edit keeps a post's key), so an edit that keeps a mention,
 * or a second read of the same page, is quiet, and an edit that adds a login routes only that login. The logins a
 * post newly mentions go one line per session: two of ours on the same session make one line.
 */
export function mentionRoutes(repo, posts, itemOf, seen, routing) {
    const after = new Map(seen);
    const routes = [];
    for (const post of posts) {
        const author = post.author.toLowerCase();
        if (routing.ours.has(author) || (routing.self !== undefined && author === routing.self.toLowerCase())) {
            continue;
        }
        const before = after.get(post.key)?.logins ?? [];
        const fresh = mentionsOf(post.text, routing.ours).filter((mention) => !before.includes(mention.login));
        if (fresh.length === 0) {
            continue;
        }
        after.set(post.key, { logins: [...before, ...fresh.map((mention) => mention.login)], updatedAt: post.updatedAt });
        const item = itemOf(post.number);
        const bySession = new Map();
        for (const mention of fresh) {
            const to = mentionRecipient(item, mention.login, routing);
            bySession.set(to, [...(bySession.get(to) ?? []), mention]);
        }
        for (const [to, mentions] of bySession) {
            const excerpt = mentions[0]?.excerpt;
            routes.push({
                to,
                ref: issueRef(repo, post.number),
                url: post.url,
                author: post.author,
                logins: mentions.map((mention) => mention.login),
                excerpt: excerpt === undefined || routing.secrets.find(excerpt) !== undefined ? undefined : excerpt,
            });
        }
    }
    return { routes, seen: after };
}
/**
 * What routing needs of each issue or pull request of `repo`, from what this run read of them: an issue's labels, and
 * the owner of the task that tracks the issue (`ownerOfRef`) or that one of our authors' own `t<id>-` branch names
 * (`ownerOfTask`, pull-news.ts), else of the first task tracking an issue the pull request closes, whatever its branch
 * or author: that is the task's change. An item this run did not read, such as an issue closed before `closedDays`,
 * routes by its task alone.
 */
export function mentionItems(repo, read, owners, ours) {
    const labels = new Map(read.issues.map((issue) => [issue.number, issue.labels]));
    const pulls = new Map(read.pulls.map((pull) => [pull.number, pull]));
    return (number) => {
        const pull = pulls.get(number);
        const branchTask = pull === undefined ? undefined : ownBranchTask(pull, ours);
        const closedOwner = () => (pull?.closes ?? []).map((closed) => owners.ofRef(issueRef(repo, closed))).find((owner) => owner !== undefined);
        return {
            labels: labels.get(number) ?? [],
            taskOwner: owners.ofRef(issueRef(repo, number)) ?? (branchTask === undefined ? undefined : owners.ofTask(branchTask)) ?? closedOwner(),
        };
    };
}
/** `ms` as a posts read takes a time: ISO, UTC, rounded down to the whole second. */
export function mentionTime(ms) {
    return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}
/** A repository's watch before its first read: it starts at `readAt`, so the scan never routes what was written before it began. */
export function firstMentionWatch(readAt) {
    return { cursor: readAt, seen: new Map() };
}
/**
 * The time a read of a repository starts at: its cursor, but no earlier than the cutoff, so a team back after a long
 * while does not hear of mentions older than the seen marks it keeps.
 */
export function mentionReadSince(watch, cutoffMs) {
    return Date.parse(watch.cursor) >= cutoffMs ? watch.cursor : mentionTime(cutoffMs);
}
/**
 * One read of a repository's posts against its watch: the routes (`mentionRoutes`) and the watch after. The next read
 * starts where this one was cut short (`cutAt`), else at `readAt`, the time this one was asked, so nothing written while
 * it read is missed; a post read twice routes nothing again. The marks of posts older than the cutoff are dropped.
 */
export function mentionStep(repo, before, read, readAt, itemOf, routing, cutoffMs) {
    const { routes, seen } = mentionRoutes(repo, read.posts, itemOf, before.seen, routing);
    return { routes, after: { cursor: read.cutAt ?? readAt, seen: prunedSeen(seen, cutoffMs) } };
}
/** The watcher's line when a read of `repo` was cut short at `cutAt`: the rest is read by the next sync. */
export function mentionCutLine(repo, cutAt) {
    return `GitHub mentions of ${repo} cut off: more posts changed than one sync reads (${MENTION_PAGES_MAX} pages of ${MENTION_PAGE_SIZE} per list, the reviews of ${REVIEW_READS_MAX} pull requests); read through ${cutAt}, the next sync goes on from there`;
}
/** The seen marks of posts written or edited at or after the cutoff time; older ones are dropped. */
export function prunedSeen(seen, cutoffMs) {
    return new Map([...seen].filter(([, mark]) => Date.parse(mark.updatedAt) >= cutoffMs));
}
/**
 * Whether each route wakes its session: the first for a session and item since MENTION_WAKE_GAP_MINUTES does, later
 * ones go in unwoken. `lastWoken` maps `<session> <ref>` to the time it was last woken; the map after is returned,
 * holding only the wakes within the gap. A question told as activity (activity.ts) shares the gap with the mentions.
 */
export function wakeRoutes(routes, lastWoken, nowMs) {
    const gapMs = MENTION_WAKE_GAP_MINUTES * 60_000;
    const after = new Map([...lastWoken].filter(([, at]) => nowMs - at < gapMs));
    const wakes = routes.map((route) => {
        const key = `${route.to} ${route.ref}`;
        if (after.has(key)) {
            return false;
        }
        after.set(key, nowMs);
        return true;
    });
    return { wakes, lastWoken: after };
}
/** The inbox line of a route. The excerpt is outside input: quoted, as data, never a command. */
export function mentionLine(route) {
    const named = route.logins.map((login) => `@${login}`).join(', ');
    const said = route.excerpt === undefined ? 'its text was left out because it looks like it holds a secret; read it there' : `it says ${JSON.stringify(route.excerpt)}`;
    return `GitHub ${route.ref} mentions ${named}: ${route.author} wrote at ${route.url}, ${said}`;
}
