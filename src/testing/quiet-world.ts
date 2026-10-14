import type { CliRuntime } from '../cli/runtime.ts';

/** The parts of a CLI run that reach outside the kit: git, the commit log and stdin. */
export type OutsideWorld = Pick<CliRuntime, 'git' | 'commitLog' | 'readStdin'>;

/**
 * The outside world when a run does not care about it: the repo on `branch` with no push target, no commits in
 * any range, and `stdin` (default empty) on stdin.
 */
export function quietWorld(branch: string = 'dev', stdin: string = ''): OutsideWorld {
  return {
    git: { branch: () => branch, pushTarget: () => undefined },
    commitLog: { between: () => [] },
    readStdin: async () => stdin,
  };
}
