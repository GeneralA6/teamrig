import { spawnSync } from 'node:child_process';
import { delimiter } from 'node:path';

/**
 * Finds a POSIX `sh` for the specs that run the real launcher under a shell (T4103). A default Git for Windows install
 * puts only its `cmd` folder on PATH, so `sh` is missing there though Git ships one; a spec that skipped on that fails
 * the coverage gate, which refuses any skipped spec.
 */

/** How this machine answers the two questions the search asks. */
export interface ShellProbe {
  /** Whether `sh -c 'exit 0'` succeeds with `env`'s PATH. */
  runs(env: NodeJS.ProcessEnv): boolean;
  /** `git --exec-path`, or undefined where git does not answer. */
  gitExecPath(): string | undefined;
}

/**
 * Git for Windows' `usr/bin` folder, which holds its `sh.exe`, from its exec path `<Git>/<mingw64 or another
 * toolchain>/libexec/git-core`; undefined for an exec path of any other shape.
 */
export function gitUsrBin(execPath: string): string | undefined {
  const parts = execPath.trim().replaceAll('\\', '/').replace(/\/+$/, '').split('/');
  if (parts.length < 4 || parts.at(-1) !== 'git-core' || parts.at(-2) !== 'libexec') {
    return undefined;
  }
  return [...parts.slice(0, -3), 'usr', 'bin'].join('/');
}

/** The name `env` holds PATH under: Windows keeps it as `Path`, and a copied environment no longer ignores case. */
function pathKeyOf(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
}

/**
 * The environment a spec runs `sh` in: `env` itself where `sh` is on its PATH, else `env` with Git's `usr/bin` first on
 * PATH, so `sh`, a script's own `sh -c` and a `#!/usr/bin/env sh` hook all resolve; undefined where neither runs it.
 */
export function posixShellEnvironment(env: NodeJS.ProcessEnv, probe: ShellProbe): NodeJS.ProcessEnv | undefined {
  if (probe.runs(env)) {
    return env;
  }
  const execPath = probe.gitExecPath();
  const bin = execPath === undefined ? undefined : gitUsrBin(execPath);
  if (bin === undefined) {
    return undefined;
  }
  const key = pathKeyOf(env);
  const current = env[key];
  const withBin = { ...env, [key]: current === undefined || current === '' ? bin : `${bin}${delimiter}${current}` };
  return probe.runs(withBin) ? withBin : undefined;
}

/** This machine's probe. */
export const nodeShellProbe: ShellProbe = {
  runs: (env) => spawnSync('sh', ['-c', 'exit 0'], { env, stdio: 'ignore', windowsHide: true }).status === 0,
  gitExecPath: () => {
    const run = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
    return run.status === 0 ? run.stdout.trim() : undefined;
  },
};
