import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { nodeTranscriptSource } from "../budget/discover.js";
import { nodeFiles } from "../core/files.js";
import { nodeStepRunner } from "../coordinator/steps.js";
import { realSleep, systemClock } from "../core/lock.js";
import { NODE_PATH_PROBE } from "../core/path-probe.js";
import { nodeProgramRunner, systemCredentials } from "../github/credentials.js";
import { nodeGhRunner } from "../github/gh.js";
import { GIT_INTEGRATE } from "../integrate/git.js";
import { nodeProcesses } from "../open/processes.js";
import { nodeSessionProcesses } from "../open/session-processes.js";
import { GIT_CLI, GIT_COMMIT_LOG } from "../push-guard/git.js";
import { requirementsCheck } from "../requirements/requirements.js";
import { nodeShellRunner } from "../test-run/shell.js";
import { NODE_WORKTREE_FILES } from "../worktree/files.js";
import { GIT_WORKTREES } from "../worktree/git.js";
import { runCli } from "./run.js";
/** The process adapter: real files, clock, git, child processes and stdio around the testable runner. */
process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    userHome: homedir(),
    cwd: process.cwd(),
    pid: process.pid,
    files: nodeFiles(realSleep),
    clock: systemClock,
    sleep: realSleep,
    git: GIT_CLI,
    commitLog: GIT_COMMIT_LOG,
    out: {
        stdout: (line) => process.stdout.write(`${line}\n`),
        stderr: (line) => process.stderr.write(`${line}\n`),
    },
    platform: process.platform,
    processes: nodeProcesses(),
    sessionProcesses: nodeSessionProcesses(),
    shell: nodeShellRunner(),
    steps: nodeStepRunner(process.platform),
    gh: nodeGhRunner(),
    credentials: systemCredentials(process.platform, nodeProgramRunner()),
    probe: NODE_PATH_PROBE,
    transcripts: nodeTranscriptSource,
    self: { node: process.execPath, script: fileURLToPath(import.meta.url) },
    requirements: requirementsCheck({ env: process.env, platform: process.platform, probe: NODE_PATH_PROBE, nodeVersion: process.versions.node }),
    worktrees: { git: GIT_WORKTREES, files: NODE_WORKTREE_FILES },
    integrateGit: GIT_INTEGRATE,
    readStdin: () => text(process.stdin),
    newId: () => randomUUID(),
});
