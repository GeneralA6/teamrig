import { errorCode, errorMessage, isRecord, stringField } from "../core/guards.js";
import { exitText } from "../open/processes.js";
import { GH_TIMEOUT_MS } from "./gh.js";
/** The issue fields read, and nothing more: never the body, which the import does not carry. */
export const ISSUE_FIELDS = ['number', 'title', 'state', 'stateReason', 'labels', 'assignees', 'url'];
/** The most issues one list returns; a list this long may have left some out, and the sync says so. */
export const ISSUE_LIMIT = 500;
/** gh's exit code when it has no login to use. */
const GH_EXIT_NO_LOGIN = 4;
const NO_LOGIN = /gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i;
const NOT_VISIBLE = /could not resolve to a repository|HTTP 404|not found/i;
/** A token that reaches the repository but was not given the Issues permission. */
const NO_PERMISSION = /resource not accessible by/i;
const URL = /^https:\/\/\S+$/;
/** The arguments for one read: a list as JSON with only ISSUE_FIELDS, never a command that writes. */
export function issueListArgs(request) {
    const search = request.closedSince === undefined ? [] : ['--search', `closed:>=${request.closedSince}`];
    return ['issue', 'list', '-R', request.repo, '--state', request.state, ...search, '--limit', String(request.limit), '--json', ISSUE_FIELDS.join(',')];
}
/** Text from outside on one plain line: control and format characters (escapes, bidi overrides) become spaces. */
export function plainLine(text) {
    return text.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
/** Lists a repository's issues in one state through gh, as `access` reads it. Every failure comes back as one line, never thrown. */
export async function listIssues(gh, access, request) {
    let result;
    try {
        result = await gh.run({ args: issueListArgs(request), env: access.env });
    }
    catch (error) {
        return { kind: 'failed', reason: startFailureText(error) };
    }
    if (result.end.kind !== 'exited' || result.end.code !== 0) {
        return { kind: 'failed', reason: failureText(request.repo, result, access) };
    }
    return parseIssueList(result.stdout, request);
}
/** Why gh did not start: most often it is not installed. */
export function startFailureText(error) {
    return errorCode(error) === 'ENOENT'
        ? 'gh, the GitHub CLI, is not installed or not on PATH: install it from https://cli.github.com, then run gh auth login'
        : plainLine(`gh could not start: ${errorMessage(error)}`);
}
/**
 * Why a gh run failed, with the fix when it is a known one, worded for what read the repository: a login
 * or token GitHub refused, a repository it cannot see, or issues it may not read.
 */
export function failureText(repo, result, access) {
    if (result.end.kind === 'signal') {
        return `gh was stopped (${result.end.signal}) before it listed the issues of ${repo}; it gets ${GH_TIMEOUT_MS / 1000} s`;
    }
    const token = `the token saved as ${access.credential}`;
    const saveOne = `save a read-only token for ${access.owner} with: ${access.save}`;
    if (result.end.code === GH_EXIT_NO_LOGIN || NO_LOGIN.test(result.stderr)) {
        return access.via === 'token'
            ? `GitHub refused ${token} (expired or revoked?): create a new one and save it again with: ${access.save}`
            : `gh is not logged in to GitHub: run gh auth login, or ${saveOne}`;
    }
    if (NO_PERMISSION.test(result.stderr)) {
        return access.via === 'token'
            ? `${token} may not read the issues of ${repo}: on GitHub, edit that token and set Issues to Read-only; its text stays the same, so nothing needs saving again`
            : `the gh login may not read the issues of ${repo}: ${saveOne}`;
    }
    if (NOT_VISIBLE.test(result.stderr)) {
        return access.via === 'token'
            ? `${repo} is not visible to ${token}: check github.repos, and on GitHub give that token this repository`
            : `${repo} is not visible to the gh login: check github.repos, or ${saveOne}`;
    }
    return plainLine(`gh issue list -R ${repo} ${exitText(result.end.code, result.stderr)}`);
}
/** gh's JSON list: each item that reads as an issue, and how many did not. */
export function parseIssueList(stdout, request) {
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    }
    catch {
        parsed = undefined;
    }
    if (!Array.isArray(parsed)) {
        return { kind: 'failed', reason: `gh printed no JSON list of the issues of ${request.repo}` };
    }
    const items = parsed;
    const issues = items.map((item) => issueOf(item, request.repo)).filter((issue) => issue !== null);
    return { kind: 'listed', issues, unreadable: items.length - issues.length, full: items.length >= request.limit };
}
function issueOf(item, repo) {
    if (!isRecord(item)) {
        return null;
    }
    const number = item['number'];
    const title = stringField(item, 'title');
    const state = stringField(item, 'state')?.toLowerCase();
    const url = stringField(item, 'url');
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || title === undefined || url === undefined || !URL.test(url)) {
        return null;
    }
    if (state !== 'open' && state !== 'closed') {
        return null;
    }
    return {
        repo,
        number,
        title,
        state,
        stateReason: stringField(item, 'stateReason') ?? '',
        labels: namesOf(item['labels'], 'name'),
        assignees: namesOf(item['assignees'], 'login'),
        url,
    };
}
/** The `key` of each object in a list, such as each label's name; anything else is left out. */
function namesOf(value, key) {
    if (!Array.isArray(value)) {
        return [];
    }
    const items = value;
    return items.filter(isRecord).flatMap((item) => {
        const name = stringField(item, key);
        return name === undefined ? [] : [name];
    });
}
