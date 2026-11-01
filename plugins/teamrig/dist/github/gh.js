import { spawn } from 'node:child_process';
import { endOf } from "../test-run/shell.js";
import { QUERY_VARIABLES, RAW_FIELD } from "./queries.js";
/**
 * The only `gh` command line teamrig runs: a page of a shipped issue query. The import never writes to GitHub (no
 * issue, label, comment or assignee change), so the runner refuses any other command line before it starts.
 *
 * True for `gh api graphql -f query=<a text of queries.ts> -f <variable>=<value> ...` and nothing more: the query
 * word for word, each variable one it declares and given once, every field raw (`-f`). Any other flag (`-F`,
 * `--paginate`, `-X`, `--input`, `--hostname`) is refused, so the run cannot read a file or send another request.
 */
export function isIssueQuery(args) {
    if (args[0] !== 'api' || args[1] !== 'graphql') {
        return false;
    }
    const fields = rawFields(args.slice(2));
    const query = fields?.get('query');
    const variables = query === undefined ? undefined : QUERY_VARIABLES.get(query);
    if (fields === null || variables === undefined) {
        return false;
    }
    return [...fields.keys()].every((key) => key === 'query' || variables.has(key));
}
/** `-f key=value` pairs by key; null when anything else is there or a key comes twice. */
function rawFields(args) {
    const fields = new Map();
    for (let at = 0; at < args.length; at += 2) {
        const flag = args[at];
        const field = args[at + 1];
        const equals = field?.indexOf('=') ?? -1;
        if (flag !== RAW_FIELD || field === undefined || equals < 1) {
            return null;
        }
        const key = field.slice(0, equals);
        if (fields.has(key)) {
            return null;
        }
        fields.set(key, field.slice(equals + 1));
    }
    return fields;
}
/** How long one `gh` run may take before it is stopped: a page of a hundred issues takes seconds. */
export const GH_TIMEOUT_MS = 60_000;
/** A command line the runner will not start, because it is not a page of a shipped issue query. */
export class GhNotReadError extends Error {
    name = 'GhNotReadError';
    constructor(args) {
        super(`teamrig only reads GitHub through its shipped issue queries: it refuses gh ${args.slice(0, 2).join(' ')} with these arguments`);
    }
}
/**
 * The real runner: `spawn` with no shell, so an issue title or a repository name can never become a
 * command. gh is told never to prompt, as nobody is there to answer. `program` and `leading` let a test
 * stand a Node script in for gh.
 */
export function nodeGhRunner(program = 'gh', leading = [], timeoutMs = GH_TIMEOUT_MS) {
    return {
        run: (request) => {
            if (!isIssueQuery(request.args)) {
                return Promise.reject(new GhNotReadError(request.args));
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
