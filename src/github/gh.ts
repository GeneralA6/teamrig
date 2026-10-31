import { spawn } from 'node:child_process';
import type { Env } from '../core/home.ts';
import { endOf, type ShellEnd } from '../test-run/shell.ts';
import { QUERY_VARIABLES, RAW_FIELD } from './queries.ts';

/**
 * The only `gh` command line teamrig runs: a page of a shipped issue query. The import never writes to GitHub (no
 * issue, label, comment or assignee change), so the runner refuses any other command line before it starts.
 *
 * True for `gh api graphql -f query=<a text of queries.ts> -f <variable>=<value> ...` and nothing more: the query
 * word for word, each variable one it declares and given once, every field raw (`-f`). Any other flag (`-F`,
 * `--paginate`, `-X`, `--input`, `--hostname`) is refused, so the run cannot read a file or send another request.
 */
export function isIssueQuery(args: readonly string[]): boolean {
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
function rawFields(args: readonly string[]): Map<string, string> | null {
  const fields = new Map<string, string>();
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

/** One `gh` run: its arguments, passed as a list and never read by a shell, and the environment. */
export interface GhRequest {
  readonly args: readonly string[];
  readonly env: Env;
}

export interface GhResult {
  readonly end: ShellEnd;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the GitHub CLI to its end with no stdin. It rejects when `gh` cannot start, such as when it is not installed. */
export interface GhRunner {
  run(request: GhRequest): Promise<GhResult>;
}

/** How long one `gh` run may take before it is stopped: a page of a hundred issues takes seconds. */
export const GH_TIMEOUT_MS = 60_000;

/** A command line the runner will not start, because it is not a page of a shipped issue query. */
export class GhNotReadError extends Error {
  override readonly name = 'GhNotReadError';

  constructor(args: readonly string[]) {
    super(`teamrig only reads GitHub through its shipped issue queries: it refuses gh ${args.slice(0, 2).join(' ')} with these arguments`);
  }
}

/**
 * The real runner: `spawn` with no shell, so an issue title or a repository name can never become a
 * command. gh is told never to prompt, as nobody is there to answer. `program` and `leading` let a test
 * stand a Node script in for gh.
 */
export function nodeGhRunner(program = 'gh', leading: readonly string[] = [], timeoutMs = GH_TIMEOUT_MS): GhRunner {
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
        const stdout: string[] = [];
        const stderr: string[] = [];
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk));
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ end: endOf(code, signal), stdout: stdout.join(''), stderr: stderr.join('') }));
      });
    },
  };
}
