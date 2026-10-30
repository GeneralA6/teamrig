import type { GitConfigReader } from '../push-guard/invocations.ts';
import { resolveDir } from '../push-guard/location.ts';
import { bashDrivePath } from '../secret-guard/paths.ts';
import type { GitContext } from './route-git.ts';

/**
 * The git routes' context (T679, security ruling C5) over what the hook can read. Who the tab is and who owns a task
 * are read only when a push line asks, and a read that fails owns nothing, so the line is no route.
 */

/** What the git routes' context reads; `caller` and `ownerOf` only when a line asks, and either may throw. */
export interface GitPorts {
  /** The folder the Bash call starts in. */
  readonly cwd: string;
  readonly home: string;
  readonly git: GitConfigReader;
  /** The session this tab is bound to; undefined for none. */
  readonly caller: () => Promise<string | undefined>;
  /** The session the register names as a task's owner; undefined for a task it lacks. */
  readonly ownerOf: (task: string) => Promise<string | undefined>;
  readonly protectedBranches: readonly string[];
}

export function gitContextOf(ports: GitPorts): GitContext {
  return {
    ownsTask: (task) => ownsTask(ports, task).catch(() => false),
    isRemote: async (folders, name) => {
      // The Bash tool's git reads `/c/x` as `C:/x` on Windows, and each `-C` from the folder the one before it left.
      const start = resolveDir(undefined, ports.cwd, ports.home);
      const dir = folders.reduce((at, folder) => resolveDir(at, bashDrivePath(folder, ports.home), ports.home), start);
      return dir !== undefined && ports.git.config(dir, `remote.${name}.url`).kind === 'set';
    },
    protectedBranches: ports.protectedBranches,
  };
}

async function ownsTask(ports: GitPorts, task: string): Promise<boolean> {
  const caller = await ports.caller();
  return caller !== undefined && (await ports.ownerOf(task)) === caller;
}
