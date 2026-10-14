import { execFile } from 'node:child_process';

/** The git commands the repo tooling needs. Implemented by `createGit`, faked in tests. */
export interface Git {
  /** Runs git and returns stdout as UTF-8 text. Rejects with `GitError` on a non-zero exit. */
  text(args: readonly string[]): Promise<string>;
  /** Runs git and returns raw stdout, for blobs that may be binary. */
  bytes(args: readonly string[]): Promise<Buffer>;
}

export class GitError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;

  constructor(args: readonly string[], stderr: string, cause: unknown) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || String(cause)}`, { cause });
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
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
            reject(new GitError(args, stderr.toString('utf8'), error));
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
