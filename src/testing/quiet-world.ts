import type { CliRuntime } from '../cli/runtime.ts';
import { loadHostPorts } from '../composition/host-ports.ts';
import { hostDeps } from './adapter-deps.ts';
import { FakeCheckout } from './fake-checkout.ts';
import { FakeCredentials, TEST_OWNERS } from './fake-credentials.ts';
import { FakeExecSpawner } from './fake-exec-spawner.ts';
import { FakeRuntimeProbe } from './fake-runtime-probe.ts';
import { FakeWebhook } from './fake-webhook.ts';
import { FakeGh } from './fake-gh.ts';
import { FakeHttp } from './fake-http.ts';
import { FakeHostCpu } from './fake-host-cpu.ts';
import { FakeHostMemory } from './fake-host-memory.ts';
import { FakeHooks } from './fake-hooks.ts';
import { FakeMergeGit } from './fake-merge-git.ts';
import { FakePullGit } from './fake-pull-git.ts';
import { FakePackageRegistry } from './fake-package-registry.ts';
import { FakePluginStore } from './fake-plugin-store.ts';
import { FakeSessionProcesses } from './fake-session-processes.ts';
import { FakeShell } from './fake-shell.ts';
import { FakeStarterWatch } from './fake-starter-watch.ts';
import { FakeSteps } from './fake-steps.ts';
import { MemoryTranscripts } from './memory-transcripts.ts';
import { noWorktrees } from './fake-worktrees.ts';
import { quietRestore } from './fake-restore.ts';

/** The parts of a CLI run that reach outside the kit: git, the commit log, stdin and the operating system. */
export type OutsideWorld = Pick<CliRuntime, 'git' | 'pointerGit' | 'commitLog' | 'secretsGit' | 'readStdin' | 'platform' | 'host' | 'processes' | 'sessionProcesses' | 'shell' | 'gh' | 'credentials' | 'http' | 'probe' | 'pluginStore' | 'self' | 'requirements' | 'transcripts' | 'worktrees' | 'restore' | 'mergeGit' | 'pulls' | 'trees' | 'hooks' | 'packageRegistry' | 'exec' | 'webhook' | 'steps' | 'memory' | 'cpu' | 'starters' | 'newId'>;

/**
 * The MB free on a quiet host: over the default floor plus a heavy step's reserve, so no step waits on the memory
 * gate; a spec that tests a memory wait sets less.
 */
export const ROOMY_FREE_MB = 16_000;

/**
 * The shipped host adapter, loaded once for every spec and given no program to run: a spec reads what the host
 * wrote through the code teamrig runs with, so a pin fails when that code changes.
 */
const SHIPPED_HOST = await loadHostPorts(hostDeps().run);

/**
 * The outside world when a run does not care about it: the repo on `branch` with no push target or config, a team pointer outside git, no commits in
 * any range, no repository the secret scan can read, `stdin` (default empty) on stdin, and a Linux host with no programs or folders and an empty plugin store,
 * so nothing starts and no session process runs, a shell command prints nothing and exits 0, gh sees no repository, a key is saved for each of TEST_OWNERS and no outside API answers; its requirements check finds
 * nothing missing, and there are no transcripts and no worktrees; merge finds only the fake repository at /w/feat
 * (testing/fake-merge-git.ts) and a pre-push check no repository, a queued step and each program a deploy runs exit 0 at once while the shell that started it
 * runs on, the host has room in memory for any queued step (`ROOMY_FREE_MB` free) and an idle CPU, the package registry holds no package, a privileged command `teamrig exec` runs exits 0 in a clean checkout of the
 * fixture request's repository (testing/fake-checkout.ts) under the runtime FakeRuntimeProbe names, and new ids count up: `id-1`, `id-2`.
 */
export function quietWorld(branch: string = 'dev', stdin: string = ''): OutsideWorld {
  let ids = 0;
  return {
    git: { branch: () => branch, head: () => undefined, pushTarget: () => undefined, config: () => ({ kind: 'unset' }) },
    pointerGit: { state: () => ({ kind: 'no-git' }) },
    commitLog: { between: () => [] },
    secretsGit: { root: () => undefined, staged: () => undefined, isCommit: () => false, commits: () => undefined, tagMessages: () => undefined, hooksDir: () => undefined, blob: () => undefined },
    readStdin: async () => stdin,
    platform: 'linux',
    host: SHIPPED_HOST,
    processes: { start: async () => ({ kind: 'missing' }), run: async () => ({ kind: 'missing' }), startHidden: async () => ({ kind: 'missing' }) },
    sessionProcesses: new FakeSessionProcesses(),
    shell: new FakeShell(),
    gh: new FakeGh(),
    credentials: new FakeCredentials().savesTokensFor(TEST_OWNERS),
    http: new FakeHttp(),
    probe: { kind: async () => 'none' },
    pluginStore: new FakePluginStore(),
    self: { node: '/usr/bin/node', script: '/opt/teamrig/dist/cli/main.js', execArgv: [] },
    requirements: { problems: async () => [] },
    transcripts: new MemoryTranscripts(),
    worktrees: noWorktrees(),
    restore: quietRestore(),
    mergeGit: new FakeMergeGit(),
    pulls: new FakePullGit(),
    trees: { checked: () => ({ kind: 'none' }) },
    hooks: new FakeHooks(),
    packageRegistry: new FakePackageRegistry(),
    exec: { spawner: new FakeExecSpawner(), checkout: new FakeCheckout(), runtime: new FakeRuntimeProbe() },
    webhook: new FakeWebhook(),
    steps: new FakeSteps(),
    memory: new FakeHostMemory(ROOMY_FREE_MB),
    cpu: new FakeHostCpu(),
    starters: new FakeStarterWatch(),
    newId: () => {
      ids += 1;
      return `id-${ids}`;
    },
  };
}
