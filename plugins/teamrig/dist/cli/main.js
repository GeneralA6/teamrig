import { homedir } from 'node:os';
import { text } from 'node:stream/consumers';
import { nodeFiles } from "../core/files.js";
import { realSleep, systemClock } from "../core/lock.js";
import { GIT_CLI } from "../push-guard/git.js";
import { runCli } from "./run.js";
/** The process adapter: real files, clock, git and stdio around the testable runner. */
process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    userHome: homedir(),
    cwd: process.cwd(),
    pid: process.pid,
    files: nodeFiles(),
    clock: systemClock,
    sleep: realSleep,
    git: GIT_CLI,
    out: {
        stdout: (line) => process.stdout.write(`${line}\n`),
        stderr: (line) => process.stderr.write(`${line}\n`),
    },
    readStdin: () => text(process.stdin),
});
