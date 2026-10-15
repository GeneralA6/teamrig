import type { CliRuntime } from '../cli/runtime.ts';
import { FakeGh } from './fake-gh.ts';
import { FakeShell } from './fake-shell.ts';
import { MemoryTranscripts } from './memory-transcripts.ts';

/** The parts of a CLI run that reach outside the kit: git, the commit log, stdin and the operating system. */
export type OutsideWorld = Pick<CliRuntime, 'git' | 'commitLog' | 'readStdin' | 'platform' | 'processes' | 'shell' | 'gh' | 'probe' | 'self' | 'requirements' | 'transcripts'>;

/**
 * The outside world when a run does not care about it: the repo on `branch` with no push target or config, no commits in
 * any range, `stdin` (default empty) on stdin, and a Linux host with no programs or folders,
 * so nothing starts, a shell command prints nothing and exits 0, and gh sees no repository; its requirements check finds
 * nothing missing, and there are no transcripts.
 */
export function quietWorld(branch: string = 'dev', stdin: string = ''): OutsideWorld {
  return {
    git: { branch: () => branch, pushTarget: () => undefined, config: () => ({ kind: 'unset' }) },
    commitLog: { between: () => [] },
    readStdin: async () => stdin,
    platform: 'linux',
    processes: { start: async () => ({ kind: 'missing' }), run: async () => ({ kind: 'missing' }) },
    shell: new FakeShell(),
    gh: new FakeGh(),
    probe: { kind: async () => 'none' },
    self: { node: '/usr/bin/node', script: '/opt/teamrig/dist/cli/main.js' },
    requirements: { problems: async () => [] },
    transcripts: new MemoryTranscripts(),
  };
}
