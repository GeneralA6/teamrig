import { execFile, execFileSync } from 'node:child_process';

/** The git commands the repo tooling needs. Implemented by `createGit`, faked in tests. */
export interface Git {
  /** Runs git and returns stdout as UTF-8 text. Rejects with `GitError` on a non-zero exit. */
  text(args: readonly string[]): Promise<string>;
  /** Runs git and returns raw stdout, for blobs that may be binary. */
  bytes(args: readonly string[]): Promise<Buffer>;
}

/**
 * How many of a failed git's last stdout lines its error names. Git passes a hook's stdout through as its own, and
 * the pre-push hook's local gate ends there with its reason: the failing check's lines, then `local checks: REFUSED`.
 */
export const STDOUT_TAIL_LINES = 40;

/** The last `count` lines of `text` once its trailing blank space is dropped, or '' when nothing else is left. */
function lastLines(text: string, count: number): string {
  const kept = text.trimEnd();
  return kept === '' ? '' : kept.split(/\r?\n/).slice(-count).join('\n');
}

/** What a failed `execFileSync` printed on `stdout` or `stderr`, which Node hangs on the error it throws. */
function printed(error: unknown): { readonly stdout: string; readonly stderr: string } {
  if (!(error instanceof Error)) return { stdout: '', stderr: '' };
  return {
    stdout: 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '',
    stderr: 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '',
  };
}

export class GitError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;
  /** The last STDOUT_TAIL_LINES lines git printed on stdout before it failed, where a hook's reason lands. */
  readonly stdoutTail: string;

  constructor(args: readonly string[], stderr: string, cause: unknown, stdout = '') {
    const stdoutTail = lastLines(stdout, STDOUT_TAIL_LINES);
    super(`git ${args.join(' ')} failed: ${stderr.trim() || String(cause)}${stdoutTail === '' ? '' : `\n${stdoutTail}`}`, { cause });
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
    this.stdoutTail = stdoutTail;
  }
}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export function createGit(cwd: string): Git {
  const run = (args: readonly string[]): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        [...args],
        { cwd, encoding: 'buffer', maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            reject(new GitError(args, stderr.toString('utf8'), error, stdout.toString('utf8')));
            return;
          }
          resolve(stdout);
        },
      );
    });
  return {
    text: async (args) => (await run(args)).toString('utf8'),
    bytes: run,
  };
}

/**
 * A synchronous git in `cwd` that returns stdout as UTF-8 text and throws when git fails, for the ship and merge
 * tools. Its buffer is bounded as `createGit`'s: a push runs the pre-push hook, whose local gate prints far past
 * Node's default 1 MiB, and git ended with ENOBUFS (T3012). A failure throws a `GitError` that names the tail of
 * that stdout, since the gate's reason prints there and Node's own error names only stderr (T4130).
 */
export function gitSyncIn(cwd: string, env?: Readonly<Record<string, string>>): (args: readonly string[]) => string {
  return (args) => {
    try {
      return execFileSync('git', [...args], { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, ...(env === undefined ? {} : { env }) });
    } catch (error) {
      const { stdout, stderr } = printed(error);
      throw new GitError(args, stderr, error, stdout);
    }
  };
}
