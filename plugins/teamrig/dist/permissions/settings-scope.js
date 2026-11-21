import { join, relative } from 'node:path';
import { samePath } from "../core/paths.js";
/** A worktree's settings files, each with the file at the same place under the project folder it was made for. */
function worktreeFiles(paths, folder, worktree) {
    return paths.folderSettings(worktree).map((file) => ({ ...file, projectFile: join(folder, relative(worktree, file.path)) }));
}
/** The user settings, then each project folder's files and its worktrees' in name order; a path named twice is listed once, as first named. */
export async function settingsScope(files, { paths, userHome }, projects, platform) {
    const scope = [{ path: paths.userSettings(userHome), kind: 'user' }];
    for (const folder of projects) {
        const worktrees = paths.worktrees(folder);
        const names = (await files.list(worktrees)).sort((left, right) => left.localeCompare(right));
        scope.push(...paths.folderSettings(folder), ...names.flatMap((name) => worktreeFiles(paths, folder, join(worktrees, name))));
    }
    return scope.filter((file, index) => scope.findIndex((other) => samePath(other.path, file.path, platform)) === index);
}
/**
 * The scope with each existing `shared` file that git does not track read as the person's own (`local`): a repository
 * that ignores `.claude/` commits no `settings.json`, so no commit can change it, and only a trim can (#837). One git
 * can not tell about stays `shared`, as does one not there (nothing to trim, and no git run spent on it).
 */
export async function ownUntracked(files, scope, inGit) {
    return Promise.all(scope.map(async (file) => file.kind === 'shared' && (await files.modifiedAt(file.path)) !== undefined && inGit(file.path) === 'untracked' ? { ...file, kind: 'local' } : file));
}
