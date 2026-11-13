import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { Writable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { nodeTranscriptSource } from '../budget/discover.ts';
import { nodeFileBytes } from '../core/file-bytes.ts';
import { nodeFiles } from '../core/files.ts';
import { GIT_TREES } from '../delivery/git-tree.ts';
import { nodeHostMemory } from '../delivery/memory.ts';
import { launchingShellsOf, nodeEvery, starterWatch } from '../delivery/starter-watch.ts';
import { nodeStepRunner } from '../delivery/steps.ts';
import { realSleep, systemClock } from '../core/lock.ts';
import { NODE_PATH_PROBE } from '../core/path-probe.ts';
import { NODE_STORE_FOLDERS } from '../core/node-store-folders.ts';
import { httpWebhook } from '../core/webhook.ts';
import { nodeProgramRunner, systemCredentials } from '../github/credentials.ts';
import { GIT_CHECKOUT } from '../exec/binding.ts';
import { nodeExecSpawner } from '../exec/runner.ts';
import { nodeGhRunner } from '../github/gh.ts';
import { GIT_MERGE } from '../merge/git.ts';
import { nodeProcesses } from '../open/processes.ts';
import { nodeSessionProcesses } from '../open/session-processes.ts';
import { httpPackageRegistry } from '../package-guard/registry.ts';
import { GIT_CLI, GIT_COMMIT_LOG } from '../push-guard/git.ts';
import { gitSecrets } from '../secret-guard/secrets-git.ts';
import { GIT_POINTER } from '../setup/pointer-git.ts';
import { requirementsCheck } from '../requirements/requirements.ts';
import { nodeHookRunner } from '../deploy/hooks.ts';
import { nodeShellRunner } from '../test-run/shell.ts';
import { NODE_WORKTREE_FILES } from '../worktree/files.ts';
import { GIT_WORKTREES } from '../worktree/git.ts';
import { stdioCountdownTerminal, terminalCountdown } from '../restore/countdown.ts';
import { LOGON_QUERY_TIMEOUT_MS, systemLogonEntry } from '../restore/logon.ts';
import { SHORTCUT_QUERY_TIMEOUT_MS, systemShortcutPlace } from '../restore/shortcut.ts';
import { SHUTDOWN_QUERY_TIMEOUT_MS, systemShutdownLog } from '../restore/shutdowns.ts';
import { processStopWatch } from '../restore/stops.ts';
import { CMD_SHIM_LINE_ENV } from './cmd-shim.ts';
import { runCli } from './run.ts';
import type { ExitCode, Output } from './runtime.ts';

/** How an entry script runs the CLI. */
export interface NodeEntry {
  /** Where the run's lines go: the process's stdio (`main.ts`), or a buffer the guard runner judges (`guard-main.ts`). */
  readonly out: Output;
  /** The CLI's entry script, `main.js`, which `teamrig open`, the idle pass and the restart start again. */
  readonly script: string;
}

/** The process's own stdout and stderr, a line at a time. */
export const PROCESS_OUTPUT: Output = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

/**
 * Ends the stack dump a reader that closed early causes (`teamrig show T1 | head -2`): the write fails with EPIPE, and
 * with no 'error' listener node throws it as an uncaught exception. The run goes on to its own exit code, since a
 * command that also writes files must not stop halfway because nobody reads its output; any other stream error still
 * throws as before.
 */
export function ignoreClosedPipe(stream: Writable): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

/**
 * The process adapter: real files, clock, git, child processes and stdio around the testable runner. Its own module,
 * apart from the entry scripts, so the guard runner can load it inside a try (T1818): one CLI module that fails to load
 * fails this import, not the entry.
 */
export async function runWithNode(argv: readonly string[], entry: NodeEntry): Promise<ExitCode> {
  // The shim's command line is this run's alone: the steps, hooks and commands it starts take `process.env`, and a
  // teamrig among them that reads it would refuse its own arguments.
  const cmdShimLine = process.env[CMD_SHIM_LINE_ENV];
  delete process.env[CMD_SHIM_LINE_ENV];
  const sessionProcesses = nodeSessionProcesses();
  return runCli(argv, {
    env: process.env,
    userHome: homedir(),
    cwd: process.cwd(),
    pid: process.pid,
    files: nodeFiles(realSleep),
    fileBytes: nodeFileBytes(realSleep),
    clock: systemClock,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sleep: realSleep,
    git: GIT_CLI,
    pointerGit: GIT_POINTER,
    commitLog: GIT_COMMIT_LOG,
    secretsGit: gitSecrets(process.env),
    out: entry.out,
    platform: process.platform,
    processes: nodeProcesses(),
    sessionProcesses,
    starters: starterWatch(sessionProcesses, { pid: process.pid, shells: launchingShellsOf(process.env, process.ppid) }, nodeEvery),
    shell: nodeShellRunner(),
    steps: nodeStepRunner(process.platform),
    memory: nodeHostMemory(process.platform),
    gh: nodeGhRunner(),
    credentials: systemCredentials(process.platform, nodeProgramRunner()),
    probe: NODE_PATH_PROBE,
    pluginStore: NODE_STORE_FOLDERS,
    transcripts: nodeTranscriptSource,
    self: { node: process.execPath, script: entry.script, execArgv: process.execArgv },
    requirements: requirementsCheck({ env: process.env, platform: process.platform, probe: NODE_PATH_PROBE, nodeVersion: process.versions.node }),
    worktrees: { git: GIT_WORKTREES, files: NODE_WORKTREE_FILES },
    restore: {
      shutdowns: systemShutdownLog(process.platform, nodeProgramRunner(SHUTDOWN_QUERY_TIMEOUT_MS)),
      countdown: terminalCountdown(stdioCountdownTerminal(process.stdin, process.stdout)),
      stops: processStopWatch(process),
      logon: systemLogonEntry(process.platform, process.env['SystemRoot'], nodeProgramRunner(LOGON_QUERY_TIMEOUT_MS)),
      shortcuts: systemShortcutPlace(process.platform, nodeProgramRunner(SHORTCUT_QUERY_TIMEOUT_MS)),
    },
    mergeGit: GIT_MERGE,
    trees: GIT_TREES,
    hooks: nodeHookRunner(process.platform),
    packageRegistry: httpPackageRegistry(),
    exec: { spawner: nodeExecSpawner(process.platform), checkout: GIT_CHECKOUT },
    webhook: httpWebhook(),
    cmdShimLine,
    readStdin: () => text(process.stdin),
    newId: () => randomUUID(),
  });
}
