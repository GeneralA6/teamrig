import type { GitConfigReader } from '../push-guard/invocations.ts';
import { bashDrivePath, resolveDir } from '../push-guard/location.ts';
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

/**
 * The `push.default` values under which git pushes a branch named alone to the remote branch of its own name; git
 * 2.51 refuses to push under any other spelling, and `upstream` (or `tracking`) sends it to the branch's upstream.
 */
const SAME_NAME_PUSH_DEFAULTS: ReadonlySet<string> = new Set(['simple', 'current', 'matching', 'nothing']);

export function gitContextOf(ports: GitPorts): GitContext {
  return {
    ownsTask: (task) => ownsTask(ports, task).catch(() => false),
    isRemote: async (folders, name) => {
      const dir = gitDirOf(ports, folders);
      return dir !== undefined && ports.git.config(dir, `remote.${name}.url`).kind === 'set';
    },
    pushesToSameName: async (folders, remote) => {
      const dir = gitDirOf(ports, folders);
      if (dir === undefined || ports.git.config(dir, `remote.${remote}.push`).kind !== 'unset') {
        return false;
      }
      const pushDefault = ports.git.config(dir, 'push.default');
      return pushDefault.kind === 'unset' || (pushDefault.kind === 'set' && SAME_NAME_PUSH_DEFAULTS.has(pushDefault.value));
    },
    protectedBranches: ports.protectedBranches,
  };
}

/** The folder git runs in: the Bash tool's git reads `/c/x` as `C:/x` on Windows, and each `-C` from the folder the one before it left. */
function gitDirOf(ports: GitPorts, folders: readonly string[]): string | undefined {
  const start = resolveDir(undefined, ports.cwd, ports.home);
  return folders.reduce((at, folder) => resolveDir(at, bashDrivePath(folder, ports.home), ports.home), start);
}

async function ownsTask(ports: GitPorts, task: string): Promise<boolean> {
  const caller = await ports.caller();
  return caller !== undefined && (await ports.ownerOf(task)) === caller;
}
