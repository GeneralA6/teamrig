import { execFile, execFileSync } from 'node:child_process';

/** The git commands the repo tooling needs. Implemented by `createGit`, faked in tests. */
export interface Git {
  /** Runs git and returns stdout as UTF-8 text. Rejects with `GitError` on a non-zero exit. */
  text(args: readonly string[]): Promise<string>;
  /** Runs git and returns raw stdout, for blobs that may be binary. */
  bytes(args: readonly string[]): Promise<Buffer>;
}

/** How many of the last lines git printed on stdout a failure names. */
const STDOUT_TAIL_LINES = 40;

/**
 * A failed git: its stderr, or the exit error when stderr is empty, then the last {@link STDOUT_TAIL_LINES} lines of its
 * stdout when it printed any. Git passes a pre-push hook's stdout through as its own, so a push the local gate refuses
 * names the failing check and the gate's REFUSED line, which stderr alone (`failed to push some refs`) never says (#1563).
 */
export class GitError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;
  readonly stdout: string;

  constructor(args: readonly string[], stderr: string, cause: unknown, stdout = '') {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || String(cause)}${tailOf(stdout)}`, { cause });
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

/** The last {@link STDOUT_TAIL_LINES} lines of `stdout` on lines of their own, or nothing when it is blank. */
function tailOf(stdout: string): string {
  const text = stdout.trimEnd();
  return text.trim() === '' ? '' : `\n${text.split(/\r?\n/).slice(-STDOUT_TAIL_LINES).join('\n')}`;
}

/** The text of `field` (`stdout`, `stderr`) on a failed `execFileSync` error, or nothing when it has none. */
function outputOf(error: unknown, field: 'stdout' | 'stderr'): string {
  if (typeof error !== 'object' || error === null || !(field in error)) {
    return '';
  }
  const value: unknown = Reflect.get(error, field);
  return typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '';
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
 * A synchronous git in `cwd` that returns stdout as UTF-8 text and throws a `GitError` when git fails, for the ship and
 * merge tools. Its buffer is bounded as `createGit`'s: a push runs the pre-push hook, whose local gate prints far past
 * Node's default 1 MiB, and git ended with ENOBUFS (T3012).
 */
export function gitSyncIn(cwd: string, env?: Readonly<Record<string, string>>): (args: readonly string[]) => string {
  return (args) => {
    try {
      return execFileSync('git', [...args], { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, ...(env === undefined ? {} : { env }) });
    } catch (error) {
      throw new GitError(args, outputOf(error, 'stderr'), error, outputOf(error, 'stdout'));
    }
  };
}
