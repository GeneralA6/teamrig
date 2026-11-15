import { spawn } from 'node:child_process';
import { endOf } from "../test-run/shell.js";
import { QUERY_VARIABLES, RAW_FIELD } from "./queries.js";
/**
 * The kinds of `gh` command line teamrig runs: a page of a shipped issue query (the import and the links read, which
 * never write to GitHub), the creation of one issue (issue migrate, which opens an issue for a team task), one
 * comment on or the close of one issue or pull request (issue comment and issue close, a close with or without its
 * reason), its labels: the read of one label of a repository, labels added to one issue, one label taken off it
 * (issue label), the read of one issue, for the id a duplicate close names (issue close --duplicate-of), logins
 * added to one issue's assignees and the read of whether one login may be assigned (the status push), and one
 * sub-issue or blocked-by link added (issue links). The runner refuses any other command line before it starts: no
 * issue edit, reopen, assignee removal, label create or delete, link removal, merge or branch delete.
 *
 * isIssueQuery is true for `gh api graphql -f query=<a text of queries.ts> -f <variable>=<value> ...` and nothing more: the query
 * word for word, each variable one it declares and given once, every field raw (`-f`). Any other flag (`-F`,
 * `--paginate`, `-X`, `--input`, `--hostname`) is refused, so the run cannot read a file or send another request.
 */
export function isIssueQuery(args) {
    if (args[0] !== 'api' || args[1] !== 'graphql') {
        return false;
    }
    const pairs = rawPairs(args.slice(2));
    const keys = pairs?.map(([key]) => key) ?? [];
    if (pairs === null || new Set(keys).size !== keys.length) {
        return false;
    }
    const query = new Map(pairs).get('query');
    const variables = query === undefined ? undefined : QUERY_VARIABLES.get(query);
    return variables !== undefined && keys.every((key) => key === 'query' || variables.has(key));
}
/**
 * A repository as GitHub names it, `owner/name`: an owner of letters, digits and `-`, a name of those and `.`
 * and `_` but never `.` or `..` alone, so the path can step to no other API.
 */
const REPO_NAME = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
/** The field gh sends as one item of the issue's label list. */
const LABEL_FIELD = 'labels[]';
/** The field gh sends as one item of the issue's assignee list. */
const ASSIGNEE_FIELD = 'assignees[]';
/** A GitHub login: letters, digits and single inner hyphens, at most 39, so it can name no other path or field. */
const LOGIN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/u;
/** Whether `login` has the shape of a GitHub login. */
export function isLogin(login) {
    return LOGIN.test(login);
}
/** The command line that opens one issue: the REST create, every field raw, so no value is read as a file or a number. */
export function issueCreateArgs(draft) {
    return ['api', `repos/${draft.repo}/issues`, '-X', 'POST', RAW_FIELD, `title=${draft.title}`, RAW_FIELD, `body=${draft.body}`, ...draft.labels.flatMap((label) => [RAW_FIELD, `${LABEL_FIELD}=${label}`])];
}
/**
 * True for `gh api repos/<owner>/<name>/issues -X POST -f title=<t> -f body=<b> [-f labels[]=<l>]...`: one
 * issue created, its title and body given once each and any labels after them. A path past `issues` (an issue
 * number, comments, labels), another method, or any other flag or field is refused, so the run can create one
 * issue and change nothing else.
 */
export function isIssueCreate(args) {
    const path = args[1] ?? '';
    if (args[0] !== 'api' || !path.startsWith('repos/') || !path.endsWith('/issues') || args[2] !== '-X' || args[3] !== 'POST') {
        return false;
    }
    const pairs = rawPairs(args.slice(4));
    if (!REPO_NAME.test(path.slice('repos/'.length, -'/issues'.length)) || pairs === null || pairs.length < 2) {
        return false;
    }
    const [title, body, ...labels] = pairs;
    return title?.[0] === 'title' && body?.[0] === 'body' && labels.every(([key]) => key === LABEL_FIELD);
}
/** The command line that posts one comment on an issue or pull request, its body a raw field so it stays text. */
export function issueCommentArgs(target, body) {
    return ['api', `repos/${target.repo}/issues/${target.number}/comments`, '-X', 'POST', RAW_FIELD, `body=${body}`];
}
/** GitHub's word for each close reason, as its REST API takes it in `state_reason`. */
const GITHUB_CLOSE_REASON = { completed: 'completed', 'not-planned': 'not_planned', duplicate: 'duplicate' };
/** The `state_reason` values a close may send: never `reopened`, which is not a close. */
const CLOSE_REASON_VALUES = new Set(Object.values(GITHUB_CLOSE_REASON));
/**
 * gh's flag for a typed field: GitHub takes a duplicate's or a link's issue id only as a number, not as the string
 * `-f` sends. gh reads a `-F` value starting with `@` from a file, so the close and isLinkAdd take digits alone there:
 * the value can only be the integer GitHub asks for.
 */
const TYPED_FIELD = '-F';
/** The field naming the issue a duplicate close duplicates, by its id (not its number). */
const DUPLICATE_FIELD = 'duplicate_issue_id';
/** `duplicate_issue_id=<id>`: a positive id of digits only, so no `@file` or other gh value form can ride on it. */
const DUPLICATE_PAIR = new RegExp(`^${DUPLICATE_FIELD}=[1-9][0-9]{0,15}$`, 'u');
/**
 * The command line that closes one issue or pull request, with the reason when one is given: the issues API closes a
 * pull request too, and GitHub keeps a reason only for an issue. A duplicate close names the issue it duplicates by
 * `duplicateId`, GitHub's id of it, which GitHub shows as the duplicate link; any other reason ignores it.
 */
export function issueCloseArgs(target, reason, duplicateId) {
    const why = reason === undefined ? [] : [RAW_FIELD, `state_reason=${GITHUB_CLOSE_REASON[reason]}`];
    const of = reason === 'duplicate' && duplicateId !== undefined ? [TYPED_FIELD, `${DUPLICATE_FIELD}=${duplicateId}`] : [];
    return ['api', `repos/${target.repo}/issues/${target.number}`, '-X', 'PATCH', RAW_FIELD, 'state=closed', ...why, ...of];
}
/** The command line that reads one issue or pull request, for its id. */
export function issueReadArgs(target) {
    return ['api', `repos/${target.repo}/issues/${target.number}`, '-X', 'GET'];
}
/** The command line that adds `labels` to one issue or pull request, each a raw item of the label list. */
export function issueLabelAddArgs(target, labels) {
    return ['api', `repos/${target.repo}/issues/${target.number}/labels`, '-X', 'POST', ...labels.flatMap((label) => [RAW_FIELD, `${LABEL_FIELD}=${label}`])];
}
/** The command line that takes `label` off one issue or pull request: the name goes in the path, encoded. */
export function issueLabelRemoveArgs(target, label) {
    return ['api', `repos/${target.repo}/issues/${target.number}/labels/${encodeURIComponent(label)}`, '-X', 'DELETE'];
}
/** The command line that adds `logins` to the assignees of one issue or pull request; those already on it stay. */
export function issueAssignArgs(target, logins) {
    return ['api', `repos/${target.repo}/issues/${target.number}/assignees`, '-X', 'POST', ...logins.flatMap((login) => [RAW_FIELD, `${ASSIGNEE_FIELD}=${login}`])];
}
/** The command line that reads whether `login` may be assigned in `repo`, which fails when it may not. */
export function assigneeReadArgs(repo, login) {
    return ['api', `repos/${repo}/assignees/${login}`];
}
/** The command line that reads one label of a repository, which fails when the repository has no such label. */
export function labelReadArgs(repo, label) {
    return ['api', `repos/${repo}/labels/${encodeURIComponent(label)}`];
}
/**
 * The characters encodeURIComponent leaves in a path segment, and its %XX escapes, so a `/`, `?` or `#` in a label
 * name stays inside the one segment.
 */
const LABEL_SEGMENT = /^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-F]{2})+$/;
/**
 * Whether `segment` is exactly what encodeURIComponent writes for a label name other than `.` or `..`, which would
 * step up the path. The shape alone would take an escape the encoder never writes, such as `%2E%2E`, which a server
 * may decode to `..`; requiring the encoder's one spelling closes that.
 */
function isLabelSegment(segment) {
    if (!LABEL_SEGMENT.test(segment)) {
        return false;
    }
    let name;
    try {
        name = decodeURIComponent(segment);
    }
    catch {
        return false;
    }
    return name !== '.' && name !== '..' && encodeURIComponent(name) === segment;
}
/** `repos/<owner>/<name>/issues/<number>`, then `/comments`, `/labels`, `/labels/<label>`, `/assignees` or nothing. */
const ISSUE_PATH = /^repos\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]{0,9})(\/comments|\/labels|\/labels\/[^/]+|\/assignees)?$/;
/** The parts a path names by a fixed tail. */
const LIST_PARTS = new Map([
    ['/comments', 'comments'],
    ['/labels', 'labels'],
    ['/assignees', 'assignees'],
]);
/** The method of `gh api <path> -X <method>`, and the part of the issue the path names, when it is one issue's; else undefined. */
function issueCall(args) {
    const match = ISSUE_PATH.exec(args[1] ?? '');
    const repo = match?.[1];
    const method = args[3];
    if (args[0] !== 'api' || match === null || repo === undefined || !REPO_NAME.test(repo) || args[2] !== '-X' || method === undefined) {
        return undefined;
    }
    const tail = match[3];
    if (tail === undefined) {
        return { method, part: 'issue' };
    }
    const part = LIST_PARTS.get(tail);
    if (part !== undefined) {
        return { method, part };
    }
    return isLabelSegment(tail.slice('/labels/'.length)) ? { method, part: 'label' } : undefined;
}
/**
 * True for `gh api repos/<owner>/<name>/issues/<number>/comments -X POST -f body=<text>` and nothing more: one
 * comment, its body the only field. Another path, method, flag or field is refused, so the run edits, labels or
 * assigns nothing.
 */
export function isIssueComment(args) {
    const call = issueCall(args);
    const pairs = rawPairs(args.slice(4));
    return call?.method === 'POST' && call.part === 'comments' && pairs?.length === 1 && pairs[0]?.[0] === 'body';
}
/**
 * True for `gh api repos/<owner>/<name>/issues/<number> -X PATCH -f state=closed [-f state_reason=<reason>]`, a
 * duplicate close also with `-F duplicate_issue_id=<digits>` last, and nothing more: the close of one issue or pull
 * request, with completed, not_planned or duplicate as its reason. Any other field (a title, a body, labels, a reopen),
 * or the duplicate's id with another reason, is refused.
 */
export function isIssueClose(args) {
    const call = issueCall(args);
    const fields = args.slice(4);
    const typed = fields.at(-2) === TYPED_FIELD ? fields.slice(-2) : [];
    const [state, reason, ...rest] = rawPairs(fields.slice(0, fields.length - typed.length)) ?? [];
    const closes = state?.[0] === 'state' && state[1] === 'closed';
    const why = reason === undefined || (reason[0] === 'state_reason' && CLOSE_REASON_VALUES.has(reason[1]));
    const of = typed.length === 0 || (reason?.[1] === GITHUB_CLOSE_REASON.duplicate && DUPLICATE_PAIR.test(typed[1] ?? ''));
    return call?.method === 'PATCH' && call.part === 'issue' && closes && why && of && rest.length === 0;
}
/**
 * True for `gh api repos/<owner>/<name>/issues/<number> -X GET` and nothing more: the read of one issue. A field
 * (which gh would send as a query, or turn the call into a write) is refused.
 */
export function isIssueRead(args) {
    const call = issueCall(args);
    return call?.method === 'GET' && call.part === 'issue' && args.length === 4;
}
/**
 * True for `gh api repos/<owner>/<name>/issues/<number>/labels -X POST -f labels[]=<label> ...` and nothing more:
 * one or more labels added to one issue or pull request. Another field, flag or method (PUT, which would replace
 * every label) is refused.
 */
export function isLabelAdd(args) {
    const call = issueCall(args);
    const pairs = rawPairs(args.slice(4));
    return call?.method === 'POST' && call.part === 'labels' && pairs !== null && pairs.length > 0 && pairs.every(([key]) => key === LABEL_FIELD);
}
/**
 * True for `gh api repos/<owner>/<name>/issues/<number>/labels/<label> -X DELETE` and nothing more: one label taken
 * off one issue or pull request. The repository's label itself stays; a field, a flag, or the DELETE of all labels
 * is refused.
 */
export function isLabelRemove(args) {
    const call = issueCall(args);
    return call?.method === 'DELETE' && call.part === 'label' && args.length === 4;
}
/**
 * True for `gh api repos/<owner>/<name>/issues/<number>/assignees -X POST -f assignees[]=<login> ...` and nothing
 * more: one or more logins added to the assignees of one issue or pull request. Another field, flag or method (DELETE,
 * which would take assignees off) is refused, and each login must have a login's shape.
 */
export function isIssueAssign(args) {
    const call = issueCall(args);
    const pairs = rawPairs(args.slice(4));
    return call?.method === 'POST' && call.part === 'assignees' && pairs !== null && pairs.length > 0 && pairs.every(([key, login]) => key === ASSIGNEE_FIELD && isLogin(login));
}
/** `repos/<owner>/<name>/assignees/<login>`: whether one login may be assigned in a repository. */
const ASSIGNEE_PATH = /^repos\/([^/]+\/[^/]+)\/assignees\/([^/]+)$/;
/**
 * True for `gh api repos/<owner>/<name>/assignees/<login>` and nothing more: a read, gh's default GET, of whether the
 * login may be assigned there. A method or field is refused.
 */
export function isAssigneeRead(args) {
    const match = ASSIGNEE_PATH.exec(args[1] ?? '');
    return args[0] === 'api' && args.length === 2 && match !== null && REPO_NAME.test(match[1] ?? '') && isLogin(match[2] ?? '');
}
/** `repos/<owner>/<name>/labels/<label>`: one label of a repository. */
const LABEL_PATH = /^repos\/([^/]+\/[^/]+)\/labels\/([^/]+)$/;
/**
 * True for `gh api repos/<owner>/<name>/labels/<label>` and nothing more: a read of one label, gh's default GET. A
 * method or field (which would create, edit or delete the label) is refused.
 */
export function isLabelRead(args) {
    const match = LABEL_PATH.exec(args[1] ?? '');
    return args[0] === 'api' && args.length === 2 && match !== null && REPO_NAME.test(match[1] ?? '') && isLabelSegment(match[2] ?? '');
}
/** `-f key=value` pairs in order; null when anything else is there. */
function rawPairs(args) {
    const pairs = [];
    for (let at = 0; at < args.length; at += 2) {
        const flag = args[at];
        const field = args[at + 1];
        const equals = field?.indexOf('=') ?? -1;
        if (flag !== RAW_FIELD || field === undefined || equals < 1) {
            return null;
        }
        pairs.push([field.slice(0, equals), field.slice(equals + 1)]);
    }
    return pairs;
}
/** How long one `gh` run may take before it is stopped: a page of a hundred issues takes seconds. */
export const GH_TIMEOUT_MS = 60_000;
/** A host id as a link write sends it: 1 to 15 digits, so it stays an exact JavaScript number. */
export const HOST_ID = /^[1-9][0-9]{0,14}$/;
/** The id field of each link endpoint: a sub-issue's, and the blocking issue's. */
const LINK_FIELDS = new Map([
    ['sub_issues', 'sub_issue_id'],
    ['dependencies/blocked_by', 'issue_id'],
]);
/** `repos/<owner>/<name>/issues/<number>/` then a link endpoint. */
const LINK_PATH = /^repos\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]{0,9})\/(sub_issues|dependencies\/blocked_by)$/;
/** The command line that puts the issue whose id is `childId` under `parent` as its sub-issue. */
export function subIssueAddArgs(parent, childId) {
    return ['api', `repos/${parent.repo}/issues/${parent.number}/sub_issues`, '-X', 'POST', TYPED_FIELD, `sub_issue_id=${childId}`];
}
/** The command line that marks `target` blocked by the issue whose id is `blockerId`. */
export function blockedByAddArgs(target, blockerId) {
    return ['api', `repos/${target.repo}/issues/${target.number}/dependencies/blocked_by`, '-X', 'POST', TYPED_FIELD, `issue_id=${blockerId}`];
}
/**
 * True for `gh api repos/<owner>/<name>/issues/<number>/sub_issues -X POST -F sub_issue_id=<id>` and for
 * `.../dependencies/blocked_by -X POST -F issue_id=<id>`, and nothing more: one link added, its id digits only.
 * Another path, method (a DELETE that removes a link, a PATCH that reorders), field or flag is refused.
 */
export function isLinkAdd(args) {
    const match = LINK_PATH.exec(args[1] ?? '');
    const repo = match?.[1];
    const key = match?.[3] === undefined ? undefined : LINK_FIELDS.get(match[3]);
    const field = args[5] ?? '';
    const equals = field.indexOf('=');
    return (args.length === 6 &&
        args[0] === 'api' &&
        repo !== undefined &&
        REPO_NAME.test(repo) &&
        args[2] === '-X' &&
        args[3] === 'POST' &&
        args[4] === TYPED_FIELD &&
        key !== undefined &&
        field.slice(0, equals) === key &&
        HOST_ID.test(field.slice(equals + 1)));
}
/** A command line the runner will not start: none of a shipped issue query's page, one issue's creation, comment, labels, close or link. */
export class GhRefusedError extends Error {
    name = 'GhRefusedError';
    constructor(args) {
        super(`teamrig only runs gh for its shipped issue queries and to open, read, comment on, label, assign, close or link an issue: it refuses gh ${args.slice(0, 2).join(' ')} with these arguments`);
    }
}
/** True for each command line the runner starts. */
export function isAllowedGh(args) {
    return (isIssueQuery(args) ||
        isIssueCreate(args) ||
        isIssueComment(args) ||
        isIssueClose(args) ||
        isLabelAdd(args) ||
        isLabelRemove(args) ||
        isLabelRead(args) ||
        isIssueRead(args) ||
        isIssueAssign(args) ||
        isAssigneeRead(args) ||
        isLinkAdd(args));
}
/**
 * The real runner: `spawn` with no shell, so an issue title or a repository name can never become a
 * command. gh is told never to prompt, as nobody is there to answer. `program` and `leading` let a test
 * stand a Node script in for gh.
 */
export function nodeGhRunner(program = 'gh', leading = [], timeoutMs = GH_TIMEOUT_MS) {
    return {
        run: (request) => {
            if (!isAllowedGh(request.args)) {
                return Promise.reject(new GhRefusedError(request.args));
            }
            return new Promise((resolve, reject) => {
                const child = spawn(program, [...leading, ...request.args], {
                    env: { ...request.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
                    stdio: ['ignore', 'pipe', 'pipe'],
                    timeout: timeoutMs,
                    windowsHide: true,
                });
                const stdout = [];
                const stderr = [];
                child.stdout.setEncoding('utf8').on('data', (chunk) => stdout.push(chunk));
                child.stderr.setEncoding('utf8').on('data', (chunk) => stderr.push(chunk));
                child.once('error', reject);
                child.once('close', (code, signal) => resolve({ end: endOf(code, signal), stdout: stdout.join(''), stderr: stderr.join('') }));
            });
        },
    };
}
