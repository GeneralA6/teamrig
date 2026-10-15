import { homedir } from 'node:os';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { nodeTranscriptSource } from "../budget/discover.js";
import { nodeFiles } from "../core/files.js";
import { realSleep, systemClock } from "../core/lock.js";
import { NODE_PATH_PROBE } from "../core/path-probe.js";
import { nodeProcesses } from "../open/processes.js";
import { GIT_CLI, GIT_COMMIT_LOG } from "../push-guard/git.js";
import { requirementsCheck } from "../requirements/requirements.js";
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
    probe: NODE_PATH_PROBE,
    transcripts: nodeTranscriptSource,
    self: { node: process.execPath, script: fileURLToPath(import.meta.url) },
    requirements: requirementsCheck({ env: process.env, platform: process.platform, probe: NODE_PATH_PROBE, nodeVersion: process.versions.node }),
    readStdin: () => text(process.stdin),
});
