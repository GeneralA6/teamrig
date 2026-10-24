import { join } from 'node:path';
import { samePath } from "../core/paths.js";
/** Where Claude Code makes a project's worktrees, from the project folder. */
const WORKTREES = ['.claude', 'worktrees'];
function projectFiles(folder) {
    return [
        { path: join(folder, '.claude', 'settings.json'), kind: 'shared' },
        { path: join(folder, '.claude', 'settings.local.json'), kind: 'local' },
    ];
}
/** The user settings, then each project folder's files and its worktrees' in name order; a path named twice is listed once, as first named. */
export async function settingsScope(files, claudeDir, projects, platform) {
    const scope = [{ path: join(claudeDir, 'settings.json'), kind: 'user' }];
    for (const folder of projects) {
        const worktrees = join(folder, ...WORKTREES);
        const names = (await files.list(worktrees)).sort((left, right) => left.localeCompare(right));
        scope.push(...projectFiles(folder), ...names.flatMap((name) => projectFiles(join(worktrees, name))));
    }
    return scope.filter((file, index) => scope.findIndex((other) => samePath(other.path, file.path, platform)) === index);
}
