import { homedir } from 'node:os';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { nodeFiles } from '../core/files.ts';
import { realSleep, systemClock } from '../core/lock.ts';
import { NODE_PATH_PROBE } from '../core/path-probe.ts';
import { nodeProcesses } from '../open/processes.ts';
import { GIT_CLI, GIT_COMMIT_LOG } from '../push-guard/git.ts';
import { runCli } from './run.ts';

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
  self: { node: process.execPath, script: fileURLToPath(import.meta.url) },
  readStdin: () => text(process.stdin),
});
