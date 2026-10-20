import type { CliRuntime } from '../cli/runtime.ts';
import { FakeCheckout } from './fake-checkout.ts';
import { FakeCredentials } from './fake-credentials.ts';
import { FakeExecSpawner } from './fake-exec-spawner.ts';
import { FakeGh } from './fake-gh.ts';
import { FakeHostMemory } from './fake-host-memory.ts';
import { FakeHooks } from './fake-hooks.ts';
import { FakeIntegrateGit } from './fake-integrate-git.ts';
import { FakePackageRegistry } from './fake-package-registry.ts';
import { FakeSessionProcesses } from './fake-session-processes.ts';
import { FakeShell } from './fake-shell.ts';
import { FakeStarterWatch } from './fake-starter-watch.ts';
import { FakeSteps } from './fake-steps.ts';
import { MemoryTranscripts } from './memory-transcripts.ts';
import { noWorktrees } from './fake-worktrees.ts';
import { quietRestore } from './fake-restore.ts';

/** The parts of a CLI run that reach outside the kit: git, the commit log, stdin and the operating system. */
export type OutsideWorld = Pick<CliRuntime, 'git' | 'commitLog' | 'readStdin' | 'platform' | 'processes' | 'sessionProcesses' | 'shell' | 'gh' | 'credentials' | 'probe' | 'self' | 'requirements' | 'transcripts' | 'worktrees' | 'restore' | 'integrateGit' | 'trees' | 'hooks' | 'packageRegistry' | 'exec' | 'steps' | 'memory' | 'starters' | 'newId'>;

/**
 * The outside world when a run does not care about it: the repo on `branch` with no push target or config, no commits in
 * any range, `stdin` (default empty) on stdin, and a Linux host with no programs or folders,
 * so nothing starts and no session process runs, a shell command prints nothing and exits 0, gh sees no repository and no token is saved; its requirements check finds
 * nothing missing, and there are no transcripts and no worktrees; integrate finds only the fake repository at /w/feat
 * (testing/fake-integrate-git.ts) and a pre-push check no repository, a heavy step and each program a roll runs exit 0 at once while the shell that started it
 * runs on, the package registry holds no package, a privileged command `teamrig exec` runs exits 0 in a clean checkout of the
 * fixture request's repository (testing/fake-checkout.ts), and new ids count up: `id-1`, `id-2`.
 */
export function quietWorld(branch: string = 'dev', stdin: string = ''): OutsideWorld {
  let ids = 0;
  return {
    git: { branch: () => branch, head: () => undefined, pushTarget: () => undefined, config: () => ({ kind: 'unset' }) },
    commitLog: { between: () => [] },
    readStdin: async () => stdin,
    platform: 'linux',
    processes: { start: async () => ({ kind: 'missing' }), run: async () => ({ kind: 'missing' }), startHidden: async () => ({ kind: 'missing' }) },
    sessionProcesses: new FakeSessionProcesses(),
    shell: new FakeShell(),
    gh: new FakeGh(),
    credentials: new FakeCredentials(),
    probe: { kind: async () => 'none' },
    self: { node: '/usr/bin/node', script: '/opt/teamrig/dist/cli/main.js' },
    requirements: { problems: async () => [] },
    transcripts: new MemoryTranscripts(),
    worktrees: noWorktrees(),
    restore: quietRestore(),
    integrateGit: new FakeIntegrateGit(),
    trees: { checked: () => ({ kind: 'none' }) },
    hooks: new FakeHooks(),
    packageRegistry: new FakePackageRegistry(),
    exec: { spawner: new FakeExecSpawner(), checkout: new FakeCheckout() },
    steps: new FakeSteps(),
    memory: new FakeHostMemory(),
    starters: new FakeStarterWatch(),
    newId: () => {
      ids += 1;
      return `id-${ids}`;
    },
  };
}
