import { execFileSync } from 'node:child_process';
import { runGit as runKitGit, type GitRun } from '../core/git-run.ts';
import { COMMIT_LOG_FORMAT, parseCommitLog, type CommitLog } from './commit-size.ts';
import type { ConfigValue } from './invocations.ts';
import type { RepoState } from './push.ts';

/** One git run's stdout; any failure (no repository, an unknown ref, no git on PATH) reads as undefined. */
function runGit(dir: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: dir, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/** One git query, trimmed; an empty answer (no upstream, a detached HEAD) reads as unknown too. */
function readGit(dir: string, args: readonly string[]): string | undefined {
  const value = runGit(dir, args)?.trim();
  return value === '' ? undefined : value;
}

/** One config value as git in `dir` reads it: git exits 1 for a key that is not set, and fails otherwise for no git or no folder. */
function readConfig(dir: string, key: string): ConfigValue {
  try {
    const value = execFileSync('git', ['config', '--get', key], { cwd: dir, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
    return { kind: 'set', value: value.replace(/\r?\n$/, '') };
  } catch (error) {
    return error instanceof Error && 'status' in error && error.status === 1 ? { kind: 'unset' } : { kind: 'unreadable' };
  }
}

/** Repository state from the git CLI. */
export const GIT_CLI: RepoState = {
  // symbolic-ref names a branch before its first commit, and nothing on a detached HEAD.
  branch: (dir) => readGit(dir, ['symbolic-ref', '--short', '-q', 'HEAD']),
  head: (dir) => readGit(dir, ['rev-parse', '--short', '-q', '--verify', 'HEAD']),
  // A name starting with `-` would read as an option, so it has no push target the guard can ask for.
  pushTarget: (dir, branch) => (branch?.startsWith('-') === true ? undefined : readGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch ?? ''}@{push}`])),
  config: readConfig,
};

/**
 * The limit on one commit-log query. The push guard runs it, once per update a Bash line pushes, inside its own 12 s
 * limit (guard-runner.ts), so it gets less than the kit's query limit.
 */
export const COMMIT_LOG_TIMEOUT_MS = 5_000;

/** Runs one git query in `dir` with a time limit; the kit's runner keeps a run that gave no answer apart from git's own exit. */
export type GitRunner = (dir: string, args: readonly string[], timeoutMs: number) => GitRun;

/** The newest commits of a range the size rule reads; older ones in a longer range go unchecked. */
export const COMMIT_LOG_MAX = 200;

/**
 * Commits from git through `run`, with renames detected so a moved file weighs its edits, not its length. A run that
 * gave no answer reads as `unanswered` (#1523), so a slow host is never reported as git refusing the range.
 */
export function commitLogWith(run: GitRunner): CommitLog {
  return {
    between: (dir, base, tip) => {
      const range = `${base}..${tip}`;
      const args = ['-c', 'core.quotePath=false', 'log', '-M', '--numstat', `--format=${COMMIT_LOG_FORMAT}`, `--max-count=${COMMIT_LOG_MAX}`, '--end-of-options', range, '--'];
      const done = run(dir, args, COMMIT_LOG_TIMEOUT_MS);
      if (done.unanswered !== undefined) {
        return { kind: 'unanswered', reason: done.unanswered };
      }
      return done.status === 0 ? { kind: 'listed', commits: parseCommitLog(done.stdout) } : { kind: 'refused' };
    },
  };
}

/** Commits from the git CLI. */
export const GIT_COMMIT_LOG: CommitLog = commitLogWith(runKitGit);
