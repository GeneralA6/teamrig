import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { text } from 'node:stream/consumers';
import { nodeTranscriptSource } from "../budget/discover.js";
import { nodeFileBytes } from "../core/file-bytes.js";
import { nodeFiles } from "../core/files.js";
import { GIT_TREES } from "../delivery/git-tree.js";
import { nodeHostMemory } from "../delivery/memory.js";
import { launchingShellsOf, nodeEvery, starterWatch } from "../delivery/starter-watch.js";
import { nodeStepRunner } from "../delivery/steps.js";
import { realSleep, systemClock } from "../core/lock.js";
import { NODE_PATH_PROBE } from "../core/path-probe.js";
import { NODE_STORE_FOLDERS } from "../core/node-store-folders.js";
import { httpWebhook } from "../core/webhook.js";
import { nodeProgramRunner, systemCredentials } from "../github/credentials.js";
import { GIT_CHECKOUT } from "../exec/binding.js";
import { nodeExecSpawner } from "../exec/runner.js";
import { nodeGhRunner } from "../github/gh.js";
import { GIT_MERGE } from "../merge/git.js";
import { nodeProcesses } from "../open/processes.js";
import { nodeSessionProcesses } from "../open/session-processes.js";
import { httpPackageRegistry } from "../package-guard/registry.js";
import { GIT_CLI, GIT_COMMIT_LOG } from "../push-guard/git.js";
import { gitSecrets } from "../secret-guard/secrets-git.js";
import { GIT_POINTER } from "../setup/pointer-git.js";
import { requirementsCheck } from "../requirements/requirements.js";
import { nodeHookRunner } from "../deploy/hooks.js";
import { nodeShellRunner } from "../test-run/shell.js";
import { NODE_WORKTREE_FILES } from "../worktree/files.js";
import { GIT_WORKTREES } from "../worktree/git.js";
import { stdioCountdownTerminal, terminalCountdown } from "../restore/countdown.js";
import { LOGON_QUERY_TIMEOUT_MS, systemLogonEntry } from "../restore/logon.js";
import { SHORTCUT_QUERY_TIMEOUT_MS, systemShortcutPlace } from "../restore/shortcut.js";
import { SHUTDOWN_QUERY_TIMEOUT_MS, systemShutdownLog } from "../restore/shutdowns.js";
import { processStopWatch } from "../restore/stops.js";
import { CMD_SHIM_LINE_ENV } from "./cmd-shim.js";
import { runCli } from "./run.js";
/** The process's own stdout and stderr, a line at a time. */
export const PROCESS_OUTPUT = {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
};
/**
 * The process adapter: real files, clock, git, child processes and stdio around the testable runner. Its own module,
 * apart from the entry scripts, so the guard runner can load it inside a try (T1818): one CLI module that fails to load
 * fails this import, not the entry.
 */
export async function runWithNode(argv, entry) {
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
        self: { node: process.execPath, script: entry.script },
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
