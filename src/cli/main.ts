import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { nodeTranscriptSource } from '../budget/discover.ts';
import { nodeFiles } from '../core/files.ts';
import { nodeStepRunner } from '../coordinator/steps.ts';
import { realSleep, systemClock } from '../core/lock.ts';
import { NODE_PATH_PROBE } from '../core/path-probe.ts';
import { nodeProgramRunner, systemCredentials } from '../github/credentials.ts';
import { nodeGhRunner } from '../github/gh.ts';
import { GIT_INTEGRATE } from '../integrate/git.ts';
import { nodeProcesses } from '../open/processes.ts';
import { nodeSessionProcesses } from '../open/session-processes.ts';
import { GIT_CLI, GIT_COMMIT_LOG } from '../push-guard/git.ts';
import { requirementsCheck } from '../requirements/requirements.ts';
import { nodeShellRunner } from '../test-run/shell.ts';
import { NODE_WORKTREE_FILES } from '../worktree/files.ts';
import { GIT_WORKTREES } from '../worktree/git.ts';
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
