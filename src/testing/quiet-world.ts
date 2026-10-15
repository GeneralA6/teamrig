import type { CliRuntime } from '../cli/runtime.ts';

/** The parts of a CLI run that reach outside the kit: git, the commit log, stdin and the operating system. */
export type OutsideWorld = Pick<CliRuntime, 'git' | 'commitLog' | 'readStdin' | 'platform' | 'processes' | 'probe' | 'self' | 'requirements'>;

/**
 * The outside world when a run does not care about it: the repo on `branch` with no push target or config, no commits in
 * any range, `stdin` (default empty) on stdin, and a Linux host with no programs or folders,
 * so nothing starts; its requirements check finds nothing missing.
 */
export function quietWorld(branch: string = 'dev', stdin: string = ''): OutsideWorld {
  return {
    git: { branch: () => branch, pushTarget: () => undefined, config: () => ({ kind: 'unset' }) },
    commitLog: { between: () => [] },
    readStdin: async () => stdin,
    platform: 'linux',
    processes: { start: async () => ({ kind: 'missing' }), run: async () => ({ kind: 'missing' }) },
    probe: { kind: async () => 'none' },
    self: { node: '/usr/bin/node', script: '/opt/teamrig/dist/cli/main.js' },
    requirements: { problems: async () => [] },
  };
}
