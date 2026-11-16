import { targetText, } from "../issues/host.js";
import { exitText } from "../open/processes.js";
import { assigneeReadArgs, blockedByAddArgs, commentsReadArgs, issueAssignArgs, issueUnassignArgs, issueBodyArgs, issueCloseArgs, issueCommentArgs, issueCreateArgs, issueLabelAddArgs, issueLabelRemoveArgs, issueReadArgs, jobLogArgs, labelReadArgs, isLogin, labelCreateArgs, subIssueAddArgs, WATCH_PATHS, watchProbeArgs, userReadArgs, } from "./gh.js";
import { probeAnswerOf } from "./probe.js";
import { ghFailureKind, ISSUE_LIMIT, listIssues, plainLine, readCommentsIn, runRead, startFailureText } from "./issues.js";
import { failedLogExcerpt } from "./job-log.js";
import { listLinks } from "./links.js";
import { createdNumber } from "./migrate.js";
import { latestIssues } from "./plan.js";
import { readPosts } from "./posts.js";
import { listPulls, PULL_LIMIT } from "./pulls.js";
import { PULL_PAGE_SIZE } from "./queries.js";
import { NoAccessError } from "./tokens.js";
/** A failed job's log read, as a failure line words it: the Actions permission lets a token read it. */
const JOB_LOG_READ = { noun: 'failed job logs', permission: 'Actions', command: 'gh run view' };
/** What each use does with an access, as its ACCESS line words it. */
const USE_VERB = { read: 'read with', open: 'opens issues with', write: 'writes with' };
/**
 * GitHub as an issue host (issues/host.ts): a list is pages of the two shipped issue queries, a links read pages of
 * the third, and each write one gh REST call the runner's allowlist takes (gh.ts), made with the token saved for the
 * repository's owner. An owner with no saved token, or one the store cannot read, is reached by nothing: never the
 * gh login in its place (tokens.ts). gh's own error, any secret shape in it redacted, is the reason a write failed.
 */
export class GitHubIssueHost {
    name = 'GitHub';
    gh;
    tokens;
    scanner;
    constructor(gh, tokens, scanner) {
        this.gh = gh;
        this.tokens = tokens;
        this.scanner = scanner;
    }
    /** Reached with the owner's saved token only; the scope is the owner, as one token serves all its repositories. */
    async reach(repo, use) {
        const access = await this.tokens.accessFor(repo);
        if (access instanceof NoAccessError) {
            return { kind: 'unreachable', reason: access.message };
        }
        const verb = USE_VERB[use];
        return {
            kind: 'reached',
            access: `${access.owner}: ${verb} the token saved as ${access.credential}`,
            scope: access.owner,
        };
    }
    /**
     * The open issues, then those closed on or after `closedSince`. When either read fails nothing of the repository
     * is given, so its tasks are not judged on half a read.
     */
    async list(repo, closedSince) {
        const access = await this.tokens.accessFor(repo);
        if (access instanceof NoAccessError) {
            return { kind: 'failed', reason: access.message };
        }
        const open = await listIssues(this.gh, access, { repo, state: 'open', limit: ISSUE_LIMIT });
        if (open.kind === 'failed') {
            return open;
        }
        const closed = await listIssues(this.gh, access, { repo, state: 'closed', closedSince, limit: ISSUE_LIMIT });
        if (closed.kind === 'failed') {
            return closed;
        }
        return { kind: 'listed', issues: latestIssues(open.issues, closed.issues), notes: [...listNotes('open', open), ...listNotes('closed', closed)] };
    }
    /**
     * The open pull requests, then those changed since `since`, as the owner's saved token reads them
     * (pulls.ts). With no `since` the second read takes one page, which only dates the next read.
     */
    async pulls(repo, since) {
        const access = await this.tokens.accessFor(repo);
        if (access instanceof NoAccessError) {
            return { kind: 'failed', reason: access.message };
        }
        const open = await listPulls(this.gh, access, { repo, read: 'open', since: undefined, limit: PULL_LIMIT });
        if (open.kind === 'failed') {
            return open;
        }
        const changed = await listPulls(this.gh, access, { repo, read: 'changed', since, limit: since === undefined ? PULL_PAGE_SIZE : PULL_LIMIT });
        if (changed.kind === 'failed') {
            return changed;
        }
        const unreadable = open.unreadable + changed.unreadable;
        const notes = [
            ...(open.full ? [`the open pull request read reached ${PULL_LIMIT}, so it may leave some out`] : []),
            ...(since !== undefined && changed.full ? [`the changed pull request read reached ${PULL_LIMIT}, so it may leave some out`] : []),
            ...(unreadable > 0 ? [`${unreadable} item(s) gh printed did not read as pull requests and were left out`] : []),
        ];
        return { kind: 'listed', open: open.pulls, changed: changed.pulls, notes };
    }
    /**
     * The end of one failed job's log (job-log.ts), as the owner's saved token reads it; each line and
     * a failure's reason have any secret shape redacted.
     */
    async jobLog(repo, jobId) {
        const access = await this.tokens.accessFor(repo);
        if (access instanceof NoAccessError) {
            return { kind: 'failed', reason: access.message };
        }
        const run = await runRead(this.gh, access, repo, jobLogArgs(repo, jobId), JOB_LOG_READ);
        if (run.kind === 'failed') {
            return { kind: 'failed', reason: this.scanner.redact(run.reason) };
        }
        return { kind: 'read', ...failedLogExcerpt(run.stdout, (text) => this.scanner.redact(text)) };
    }
    /** The posts of `repo` changed since `since` (posts.ts), as the owner's saved token reads them. */
    async posts(repo, since) {
        const access = await this.tokens.accessFor(repo);
        if (access instanceof NoAccessError) {
            return { kind: 'failed', reason: access.message };
        }
        const read = await readPosts(this.gh, access, repo, since);
        if (read.kind === 'failed') {
            return { kind: 'failed', reason: this.scanner.redact(read.reason) };
        }
        const notes = read.unreadable > 0 ? [`${read.unreadable} item(s) gh printed did not read as comments, reviews or bodies and were left out`] : [];
        return { kind: 'read', posts: read.posts, cutAt: read.cutAt, notes };
    }
    /**
     * Opens one issue. A failure is one plain line with gh's own first error line, any secret shape in it redacted; a
     * run stopped by a signal, or one that printed no issue number, may still have opened it, so its line says to
     * look before a rerun.
     */
    async open(draft) {
        const access = await this.tokens.accessFor(draft.repo);
        if (access instanceof NoAccessError) {
            return { kind: 'failed', reason: access.message };
        }
        let result;
        try {
            result = await this.gh.run({ args: issueCreateArgs(draft), env: access.env });
        }
        catch (error) {
            return { kind: 'failed', reason: startFailureText(error) };
        }
        const look = `look for it on ${draft.repo} before a rerun, and set the task's ref if it is there`;
        if (result.end.kind === 'signal') {
            return { kind: 'failed', reason: `gh was stopped (${result.end.signal}) while opening the issue: ${look}` };
        }
        if (result.end.code !== 0) {
            return { kind: 'failed', reason: this.scanner.redact(plainLine(`gh api for an issue of ${draft.repo} ${exitText(result.end.code, result.stderr)}`)) };
        }
        const number = createdNumber(result.stdout);
        return number === undefined ? { kind: 'failed', reason: `gh printed no issue number: ${look}` } : { kind: 'opened', target: { repo: draft.repo, number } };
    }
    comment(target, body) {
        return this.write(target, issueCommentArgs(target, body), 'comment on');
    }
    editBody(target, body) {
        return this.write(target, issueBodyArgs(target, body), 'edit the body of');
    }
    close(target, reason, duplicateId) {
        return this.write(target, issueCloseArgs(target, reason, duplicateId), 'close');
    }
    /**
     * Reads the one issue for its `id`: found with it, missing when GitHub answers Not Found (no such issue, or one the
     * access cannot see), else failed with gh's own line, or when the answer holds no id.
     */
    async issueId(target) {
        const shown = targetText(target);
        const access = await this.tokens.accessFor(target.repo);
        if (access instanceof NoAccessError) {
            return { kind: 'failed', reason: access.message };
        }
        let result;
        try {
            result = await this.gh.run({ args: issueReadArgs(target), env: access.env });
        }
        catch (error) {
            return { kind: 'failed', reason: startFailureText(error) };
        }
        if (result.end.kind === 'signal') {
            return { kind: 'failed', reason: `gh was stopped (${result.end.signal}) while reading ${shown}` };
        }
        if (result.end.code !== 0) {
            return ghFailureKind(result.end.code, result.stderr) === 'not-visible'
                ? { kind: 'missing' }
                : { kind: 'failed', reason: this.scanner.redact(plainLine(`gh api to read ${shown} ${exitText(result.end.code, result.stderr)}`)) };
        }
        const id = issueIdIn(result.stdout);
        return id === undefined ? { kind: 'failed', reason: `gh printed no id for ${shown}` } : { kind: 'found', id };
    }
    /**
     * Reads the one label: found when gh ends well, missing when GitHub answers Not Found (no such label, or a
     * repository the access cannot see, which the add would fail on anyway), else failed with gh's own line.
     */
    async labelExists(repo, label) {
        const read = await this.read(repo, labelReadArgs(repo, label), `the label ${JSON.stringify(label)} of ${repo}`);
        return read.kind === 'found' ? { kind: 'found' } : read;
    }
    /**
     * Reads one page of the issue's comments updated at or after `since`, oldest first (gh.ts commentsReadArgs), each
     * with its text matched for a claim line and dropped. An issue GitHub no longer shows fails the read.
     */
    async newComments(target, since) {
        const shown = `the new comments of ${targetText(target)}`;
        const read = await this.read(target.repo, commentsReadArgs(target, new Date(since).toISOString()), shown);
        if (read.kind === 'missing') {
            return { kind: 'failed', reason: `GitHub shows no ${targetText(target)} to read ${shown} of` };
        }
        if (read.kind === 'failed') {
            return read;
        }
        const comments = readCommentsIn(read.stdout);
        return comments === undefined ? { kind: 'failed', reason: `gh printed no comment list for ${shown}` } : { kind: 'read', comments };
    }
    /**
     * Reads whether the login may be assigned, as GitHub spells it. GitHub's assignee check matches a login's case
     * exactly (`octocat` is Not Found where `OctoCat` is the user), while teamrig keeps logins in lowercase, so the user
     * is read first for its login as GitHub keeps it. Found with that login when gh ends well; missing when GitHub answers
     * Not Found (no such user, not a person with access, an organisation, or a repository the access cannot see); else
     * failed with gh's own line.
     */
    async assigneeExists(repo, login) {
        const user = await this.read(repo, userReadArgs(login), `the GitHub user ${login}`);
        if (user.kind !== 'found') {
            return user;
        }
        const spelled = loginIn(user.stdout);
        if (spelled === undefined || spelled.toLowerCase() !== login.toLowerCase()) {
            return { kind: 'failed', reason: `gh printed no login ${login} for the GitHub user ${login}` };
        }
        const read = await this.read(repo, assigneeReadArgs(repo, spelled), `whether ${spelled} may be assigned in ${repo}`);
        return read.kind === 'found' ? { kind: 'found', login: spelled } : read;
    }
    /** One read of `what` in `repo`: found with what gh printed when it ends well, missing on Not Found, else failed with gh's own line. */
    async read(repo, args, what) {
        const access = await this.tokens.accessFor(repo);
        if (access instanceof NoAccessError) {
            return { kind: 'failed', reason: access.message };
        }
        let result;
        try {
            result = await this.gh.run({ args, env: access.env });
        }
        catch (error) {
            return { kind: 'failed', reason: startFailureText(error) };
        }
        if (result.end.kind === 'signal') {
            return { kind: 'failed', reason: `gh was stopped (${result.end.signal}) while reading ${what}` };
        }
        if (result.end.code === 0) {
            return { kind: 'found', stdout: result.stdout };
        }
        if (ghFailureKind(result.end.code, result.stderr) === 'not-visible') {
            return { kind: 'missing' };
        }
        return { kind: 'failed', reason: this.scanner.redact(plainLine(`gh api to read ${what} ${exitText(result.end.code, result.stderr)}`)) };
    }
    /**
     * Makes the label in the repository. A run stopped by a signal may still have made it, which the next run's read
     * finds; a refused access says how to give it the write.
     */
    async createLabel(repo, label) {
        const shown = `the label ${JSON.stringify(label.name)} in ${repo}`;
        const access = await this.tokens.accessFor(repo);
        if (access instanceof NoAccessError) {
            return { kind: 'failed', reason: access.message };
        }
        let result;
        try {
            result = await this.gh.run({ args: labelCreateArgs(repo, label), env: access.env });
        }
        catch (error) {
            return { kind: 'failed', reason: startFailureText(error) };
        }
        if (result.end.kind === 'signal') {
            return { kind: 'failed', reason: `gh was stopped (${result.end.signal}) while making ${shown}` };
        }
        if (result.end.code !== 0) {
            return { kind: 'failed', reason: this.scanner.redact(plainLine(`gh api to make ${shown} ${exitText(result.end.code, result.stderr)}`)) };
        }
        return { kind: 'done' };
    }
    addLabels(target, labels) {
        return this.write(target, issueLabelAddArgs(target, labels), 'label');
    }
    /** Takes the label off; Not Found here means the issue does not carry it (or is not there), which the reason says. */
    removeLabel(target, label) {
        const shown = JSON.stringify(label);
        return this.write(target, issueLabelRemoveArgs(target, label), `take ${shown} off`, `${targetText(target)} does not carry the label ${shown}, or is not there`);
    }
    /** Every issue of the repository with its links, read with the same access as a list. */
    async links(repo) {
        const access = await this.tokens.accessFor(repo);
        return access instanceof NoAccessError ? { kind: 'failed', reason: access.message } : listLinks(this.gh, access, repo);
    }
    addSubIssue(parent, childId) {
        return this.write(parent, subIssueAddArgs(parent, childId), 'add a sub-issue to');
    }
    addBlockedBy(target, blockerId) {
        return this.write(target, blockedByAddArgs(target, blockerId), 'add a blocker to');
    }
    assign(target, logins) {
        return this.write(target, issueAssignArgs(target, logins), 'assign');
    }
    /**
     * Probes each of WATCH_PATHS with the tag `marks` holds for it (gh.ts isWatchProbe), each mark keyed by its path.
     * Changed when any answer changed, the new tags in the marks it gives (a path that failed keeps its old tag, so it
     * reads as changed again later); failed when none changed and one failed, with that line, any secret shape
     * redacted; else unchanged. GitHub answers an unchanged probe 304, which does not count against the rate limit.
     */
    async watch(repo, marks) {
        const access = await this.tokens.accessFor(repo);
        if (access instanceof NoAccessError) {
            return { kind: 'failed', reason: access.message };
        }
        const next = new Map(marks);
        let changed = false;
        let failure;
        for (const path of WATCH_PATHS) {
            const answer = await this.probe(repo, path, marks.get(path), access.env);
            if (answer.kind === 'changed') {
                changed = true;
                if (answer.tag === undefined) {
                    next.delete(path);
                }
                else {
                    next.set(path, answer.tag);
                }
            }
            else if (answer.kind === 'failed') {
                failure ??= `${repo} ${path.slice(0, path.indexOf('?'))}: ${answer.reason}`;
            }
        }
        if (changed) {
            return { kind: 'changed', marks: next };
        }
        return failure === undefined ? { kind: 'unchanged' } : { kind: 'failed', reason: this.scanner.redact(failure) };
    }
    async probe(repo, path, tag, env) {
        try {
            return probeAnswerOf(await this.gh.run({ args: watchProbeArgs(repo, path, tag), env }));
        }
        catch (error) {
            return { kind: 'failed', reason: startFailureText(error) };
        }
    }
    unassign(target, login) {
        return this.write(target, issueUnassignArgs(target, login), `take ${login} off the assignees of`);
    }
    /** One write; `missing`, when given, says what a Not Found means for it in place of the issue not being there. */
    async write(target, args, what, missing) {
        const access = await this.tokens.accessFor(target.repo);
        if (access instanceof NoAccessError) {
            return { kind: 'failed', reason: access.message };
        }
        let result;
        try {
            result = await this.gh.run({ args, env: access.env });
        }
        catch (error) {
            return { kind: 'failed', reason: startFailureText(error) };
        }
        if (result.end.kind === 'signal') {
            return { kind: 'failed', reason: `gh was stopped (${result.end.signal}) on its way to ${what} ${targetText(target)}: look on GitHub before a rerun` };
        }
        if (result.end.code !== 0) {
            const notThere = missing !== undefined && ghFailureKind(result.end.code, result.stderr) === 'not-visible';
            return { kind: 'failed', reason: notThere ? missing : this.scanner.redact(writeFailureText(target, what, result.end.code, result.stderr, access)) };
        }
        return { kind: 'done' };
    }
}
/** What a reader of the sync should know about one list: it may be cut short, or gh printed items it could not read. */
function listNotes(state, list) {
    return [
        ...(list.full ? [`the ${state} list reached ${ISSUE_LIMIT} issues, so it may leave some out`] : []),
        ...(list.unreadable > 0 ? [`${list.unreadable} ${state} item(s) gh printed did not read as issues and were left out`] : []),
    ];
}
/** Why a write failed, with the fix when it is a known one: a refused token, a missing permission, an issue not there. */
export function writeFailureText(target, what, code, stderr, access) {
    const shown = targetText(target);
    const token = `the token saved as ${access.credential}`;
    switch (ghFailureKind(code, stderr)) {
        case 'no-login':
            return `GitHub refused ${token} (expired or revoked?): create a new one and save it again with: ${access.save}`;
        case 'no-permission':
            return `${token} may not ${what} ${shown}: on GitHub, edit that token and set Issues and Pull requests to Read and write; its text stays the same, so nothing needs saving again`;
        case 'not-visible':
            return `${shown} is not there for ${token}: check the number, and that the token reaches ${target.repo}`;
        case undefined:
            return plainLine(`gh api to ${what} ${shown} ${exitText(code, stderr)}`);
    }
}
/** The `login` of a user as `gh api users/<login>` prints it, when it has a login's shape; else undefined. */
export function loginIn(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || !('login' in parsed)) {
        return undefined;
    }
    const { login } = parsed;
    return typeof login === 'string' && isLogin(login) ? login : undefined;
}
/** The `id` of an issue as GitHub's REST API prints it: a positive safe integer, else undefined. */
export function issueIdIn(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || !('id' in parsed)) {
        return undefined;
    }
    const { id } = parsed;
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
