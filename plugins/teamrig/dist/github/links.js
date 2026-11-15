import { isRecord, recordField, stringField } from "../core/guards.js";
import { HOST_ID } from "./gh.js";
import { failureText, nodesOf, plainLine, startFailureText } from "./issues.js";
import { linksPageArgs } from "./queries.js";
/**
 * The most issues a links read takes before it stops asking for pages. Unlike the import, it reads closed issues
 * too, since a closed part still blocks its whole; fifty pages is a repository far past any team's tree.
 */
export const LINKED_ISSUE_LIMIT = 5000;
/**
 * Reads every issue of `repo` (`owner/name`) with its links through gh, as `access` reads it: page after page until
 * GitHub has no more or `limit` items are read. Any page failing fails the whole read, so no link is planned on half
 * of it. Every failure comes back as one line, never thrown.
 */
export async function listLinks(gh, access, repo, limit = LINKED_ISSUE_LIMIT) {
    const [owner, name, ...rest] = repo.split('/');
    if (owner === undefined || owner === '' || name === undefined || name === '' || rest.length > 0) {
        return { kind: 'failed', reason: `${plainLine(repo)} is not owner/name: check github.repos` };
    }
    const issues = [];
    let unreadable = 0;
    let items = 0;
    let next;
    let empty = false;
    do {
        const page = await readLinksPage(gh, access, repo, linksPageArgs({ owner, name, after: next }));
        if (page.kind === 'failed') {
            return page;
        }
        issues.push(...page.issues);
        unreadable += page.unreadable;
        items += page.items;
        next = page.next;
        // A page with nothing on it ends the read even when GitHub says more follow, so a bad answer cannot loop.
        empty = page.items === 0;
    } while (!empty && next !== undefined && items < limit);
    const notes = [
        ...(next !== undefined && empty ? ['GitHub sent an empty page that said more follow, so the links read may leave some out'] : []),
        ...(next !== undefined && !empty ? [`the links read reached ${limit} issues, so it may leave some out`] : []),
        ...(unreadable > 0 ? [`${unreadable} item(s) gh printed did not read as issues with links and were left out`] : []),
    ];
    return { kind: 'listed', issues, notes };
}
async function readLinksPage(gh, access, repo, args) {
    let result;
    try {
        result = await gh.run({ args, env: access.env });
    }
    catch (error) {
        return { kind: 'failed', reason: startFailureText(error) };
    }
    if (result.end.kind !== 'exited' || result.end.code !== 0) {
        return { kind: 'failed', reason: failureText(repo, result, access) };
    }
    return parseLinksPage(result.stdout, repo);
}
/**
 * One page as `gh api graphql` prints the links query (`data.repository.issues`). An issue whose id, parent or any
 * blocker does not read is left out whole and counted: a link planned on part of what GitHub holds could be one it
 * already has, which it refuses.
 */
export function parseLinksPage(stdout, repo) {
    const failed = { kind: 'failed', reason: `gh printed no page of the issue links of ${repo}` };
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    }
    catch {
        return failed;
    }
    const data = isRecord(parsed) ? recordField(parsed, 'data') : undefined;
    const repository = data === undefined ? undefined : recordField(data, 'repository');
    const connection = repository === undefined ? undefined : recordField(repository, 'issues');
    const pageInfo = connection === undefined ? undefined : recordField(connection, 'pageInfo');
    const nodes = connection?.['nodes'];
    if (pageInfo === undefined || !Array.isArray(nodes)) {
        return failed;
    }
    const more = pageInfo['hasNextPage'] === true;
    const cursor = stringField(pageInfo, 'endCursor');
    if (more && (cursor === undefined || cursor === '')) {
        return failed;
    }
    const items = nodes;
    const read = items.map((item) => linkedOf(item, repo.toLowerCase()));
    const issues = read.filter((issue) => issue !== null);
    return { kind: 'page', issues, unreadable: items.length - issues.length, items: items.length, next: more ? cursor : undefined };
}
/** An issue of `repo` (lowercase) with its links, or null when any part of it does not read. */
function linkedOf(item, repo) {
    const self = isRecord(item) ? numberOf(item) : undefined;
    const id = isRecord(item) ? stringField(item, 'fullDatabaseId') : undefined;
    if (!isRecord(item) || self === undefined || id === undefined || !HOST_ID.test(id)) {
        return null;
    }
    const parentField = item['parent'];
    const parent = parentField === null || parentField === undefined ? undefined : issueRef(parentField);
    const blockers = nodesOf(item['blockedBy']).map(issueRef);
    if (parent === null || blockers.includes(null)) {
        return null;
    }
    const blockedBy = blockers.flatMap((blocker) => (blocker !== null && blocker.repo === repo ? [blocker.number] : []));
    return { number: self, hostId: Number(id), parent, blockedBy };
}
/** `{ number, repository { nameWithOwner } }` as a repository (lowercase) and number; null when it does not read. */
function issueRef(value) {
    const number = isRecord(value) ? numberOf(value) : undefined;
    const repository = isRecord(value) ? recordField(value, 'repository') : undefined;
    const name = repository === undefined ? undefined : stringField(repository, 'nameWithOwner');
    return number === undefined || name === undefined || !name.includes('/') ? null : { repo: name.toLowerCase(), number };
}
/** An issue number: a whole number from 1 up. */
function numberOf(record) {
    const number = record['number'];
    return typeof number === 'number' && Number.isSafeInteger(number) && number >= 1 ? number : undefined;
}
