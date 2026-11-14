import { bashDrivePath, resolveDir } from "../push-guard/location.js";
/**
 * The `push.default` values under which git pushes a branch named alone to the remote branch of its own name; git
 * 2.51 refuses to push under any other spelling, and `upstream` (or `tracking`) sends it to the branch's upstream.
 */
const SAME_NAME_PUSH_DEFAULTS = new Set(['simple', 'current', 'matching', 'nothing']);
export function gitContextOf(ports) {
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
function gitDirOf(ports, folders) {
    const start = resolveDir(undefined, ports.cwd, ports.home);
    return folders.reduce((at, folder) => resolveDir(at, bashDrivePath(folder, ports.home), ports.home), start);
}
async function ownsTask(ports, task) {
    const caller = await ports.caller();
    return caller !== undefined && (await ports.ownerOf(task)) === caller;
}
