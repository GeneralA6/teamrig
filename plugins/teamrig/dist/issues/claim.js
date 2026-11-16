import { isRecord } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { DESIGN_LABEL } from "./design-label.js";
import { isLogin } from "../github/gh.js";
import { isInsider, issueTrust } from "../github/trust.js";
/**
 * A contributor claims an open issue by a comment, and code assigns them (T3021 design, section 1). This file holds
 * the decisions only: which comment is a claim, which claims a sync makes, and which run out. It reads and writes
 * nothing; the sync applies its plan.
 */
/** Days a claim holds with no linked pull request before code takes the assignee off again. */
export const CLAIM_DAYS = 7;
const DAY_MS = 86_400_000;
/**
 * The most claims code makes in one repository in a day. Many throwaway accounts could otherwise tie up every open
 * issue for a week; past the cap a claim comment waits for a person, who assigns by hand.
 */
export const CLAIMS_PER_DAY = 5;
/** A security issue is handled in private by the maintainers, never taken by a comment. */
const SECURITY_LABEL = 'security';
/**
 * A claim line: only `/take`, or a line starting "I'll take", "I'm working on" or "I can take", either apostrophe.
 * Anchored at the line's start, so a quoted line (`> I'll take`) is someone else's words and no claim.
 */
const CLAIM_LINE = /^(?:\/take$|(?:i['’]ll take|i['’]m working on|i can take)\b)/i;
const FENCE = /^(?:```|~~~)/;
/** True when one line of `body`, outside a fenced block, is a claim line. */
export function isClaim(body) {
    let fenced = false;
    for (const raw of body.split(/\r?\n/)) {
        const line = raw.trim();
        if (FENCE.test(line)) {
            fenced = !fenced;
        }
        else if (!fenced && CLAIM_LINE.test(line)) {
            return true;
        }
    }
    return false;
}
/** The format of the claims file this code writes; a file in another format, or damaged, reads as no claim made. */
export const CLAIM_STATE_FORMAT = 1;
/**
 * The state a file holds; a damaged entry is left out, a damaged file reads as no claim and no time. Reading none is
 * the safe side: a claim code no longer knows is never taken off, it only stays until a person does, and a missing
 * time reads no old comment as a new claim.
 */
export function parseClaims(text) {
    const record = parseObject(text.trim());
    const current = record?.[VERSION_FIELD] === CLAIM_STATE_FORMAT ? record : undefined;
    const list = current?.['claims'];
    const checked = current?.['checked'];
    return {
        claims: Array.isArray(list) ? list.flatMap(claimOf) : [],
        checked: new Map(isRecord(checked) ? Object.entries(checked).flatMap(checkedOf) : []),
    };
}
function checkedOf([repo, at]) {
    return typeof at === 'number' && Number.isFinite(at) ? [[repo, at]] : [];
}
function claimOf(value) {
    if (!isRecord(value)) {
        return [];
    }
    const { repo, number, login, at } = value;
    const valid = typeof repo === 'string' && typeof login === 'string' && login !== '' && Number.isSafeInteger(number) && typeof number === 'number' && number > 0;
    return valid && typeof at === 'number' && Number.isFinite(at) ? [{ repo, number, login, at }] : [];
}
export function formatClaims(state) {
    return toJsonlLine({
        [VERSION_FIELD]: CLAIM_STATE_FORMAT,
        claims: state.claims.map(({ repo, number, login, at }) => ({ repo, number, login, at })),
        checked: Object.fromEntries(state.checked),
    });
}
/** The account kind of a person; an app (`Bot`) or an organization never claims. */
const PERSON = 'User';
/**
 * The most issues one claim pass reads the new comments of in a repository (IssueHost.newComments, one page each),
 * so a flood of comments cannot turn one sync into hundreds of reads; the rest wait for the next pass.
 */
export const CLAIM_READS = 10;
/**
 * The claims code made before, sorted: those whose issue closed, or whose login is no longer an assignee (handed
 * over, or taken off by hand), are dropped with no write; one past its days with no linked pull request ran out.
 */
function sortClaims(issues, claims, now) {
    const byNumber = new Map(issues.map((issue) => [claimKey(issue.repo, issue.number), issue]));
    const kept = [];
    const expired = [];
    for (const claim of claims) {
        const issue = byNumber.get(claimKey(claim.repo, claim.number));
        if (issue === undefined || issue.state !== 'open' || !issue.assignees.includes(claim.login)) {
            continue;
        }
        if (issue.linkedPulls === 0 && now - claim.at >= CLAIM_DAYS * DAY_MS) {
            expired.push(claim);
        }
        else {
            kept.push(claim);
        }
    }
    return { kept, expired };
}
/** The key of one issue in the comments a claim pass read. */
export function claimKey(repo, number) {
    return `${repo}#${number}`;
}
/**
 * The issues whose comments a claim pass reads, oldest new comment first: claimable ones with a comment since
 * `since` by an outside person holding no claim, as the list shows it (never the text). None once the repository
 * made its claims for the day.
 */
export function claimCandidates(issues, claims, pass) {
    const { kept } = sortClaims(issues, claims, pass.now);
    const candidates = [];
    for (const issue of issues) {
        const own = kept.filter((claim) => claim.repo === issue.repo);
        if (own.filter((claim) => pass.now - claim.at < DAY_MS).length >= CLAIMS_PER_DAY || !claimable(issue, pass.acceptLabel)) {
            continue;
        }
        const holding = new Set(own.map((claim) => claim.login));
        const times = issue.comments.filter((comment) => mayClaim(comment, pass.since, holding)).map((comment) => Date.parse(comment.at));
        if (times.length > 0) {
            candidates.push({ issue, from: Math.min(...times) });
        }
    }
    return candidates.sort((a, b) => a.from - b.from);
}
/**
 * The claims of one repository after a sync: `claims` are those code made before (only these may ever lose their
 * assignee), `issues` the repository's issues as just read, and `comments` the new comments the pass read, by
 * claimKey; an issue with none read makes no claim.
 */
export function planClaims(issues, claims, times, comments) {
    const { kept, expired } = sortClaims(issues, claims, times.now);
    const made = [];
    const today = (repo) => [...kept, ...made].filter((claim) => claim.repo === repo && times.now - claim.at < DAY_MS).length;
    for (const issue of issues) {
        if (today(issue.repo) >= CLAIMS_PER_DAY || !claimable(issue, times.acceptLabel)) {
            continue;
        }
        const holding = new Set([...kept, ...made].filter((claim) => claim.repo === issue.repo).map((claim) => claim.login));
        const comment = firstClaim(comments.get(claimKey(issue.repo, issue.number)) ?? [], times.since, holding);
        if (comment !== undefined) {
            // The claim's time is when code made it, not the comment's: a backlog of old comments read in one pass still
            // counts toward today's cap, and the claim runs its full days from its assignment.
            made.push({ repo: issue.repo, number: issue.number, login: comment.login, at: times.now });
        }
    }
    return { made, expired, kept };
}
/**
 * An open issue with no assignee that is neither a design issue (talk, never work to take) nor a security one, and is
 * the repository's own or accepted: an outsider's issue no one accepted is no work yet, so it is no one's to claim.
 */
function claimable(issue, acceptLabel) {
    const labels = issue.labels.map((label) => label.toLowerCase());
    return (issue.state === 'open' &&
        issue.assignees.length === 0 &&
        !labels.includes(DESIGN_LABEL) &&
        !labels.includes(SECURITY_LABEL) &&
        issueTrust(issue, acceptLabel) !== 'untrusted');
}
/** True for a comment since `since` by an outside person holding no other claim in the repository. */
function mayClaim(comment, since, holding) {
    return Date.parse(comment.at) >= since && isLogin(comment.login) && comment.authorKind === PERSON && !isInsider(comment.authorAssociation) && !holding.has(comment.login);
}
/** The oldest claim comment among `comments` that mayClaim allows. */
function firstClaim(comments, since, holding) {
    return [...comments].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).find((comment) => comment.claims && mayClaim(comment, since, holding));
}
