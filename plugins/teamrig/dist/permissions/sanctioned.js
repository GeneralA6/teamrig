import { matchesGitCommit, matchesGitPush } from "./route-git.js";
import { KIT_SHAPES, matchesKit } from "./route-kit.js";
import { plainWordsOf } from "./route-line.js";
const kit = (shape) => async (words, context) => matchesKit(shape, words, context);
/** The table, in the order {@link routeOf} asks; no line matches two entries. */
export const SANCTIONED_ROUTES = [
    {
        id: 'merge',
        purpose: "merge the branch checked out here into origin's default branch",
        canary: 'teamrig merge --session tr-canary',
        preToolUse: true,
        match: kit(KIT_SHAPES.merge),
    },
    {
        id: 'deploy',
        purpose: "bring what was pushed to a repository's default branch to the running system",
        canary: 'teamrig deploy --session tr-canary --repo canary',
        preToolUse: true,
        match: kit(KIT_SHAPES.deploy),
    },
    {
        id: 'exec-request',
        purpose: 'ask the security reviewer to run a privileged command',
        canary: 'teamrig exec request --session tr-canary --file C:/canary/request.json',
        preToolUse: true,
        match: kit(KIT_SHAPES.execRequest),
    },
    {
        id: 'worktree-remove',
        purpose: 'remove a worktree of your own, unlinking its node_modules first',
        canary: 'teamrig worktree remove C:/canary/t1-canary --session tr-canary --dry-run',
        preToolUse: true,
        match: kit(KIT_SHAPES.worktreeRemove),
    },
    {
        id: 'register',
        purpose: 'read and write the task register and the inbox',
        canary: 'teamrig list --session tr-canary',
        preToolUse: false,
        match: kit(KIT_SHAPES.register),
    },
    {
        id: 'git-commit',
        purpose: 'commit with the hooks running',
        canary: 'git -C C:/canary commit -s -m canary',
        preToolUse: true,
        match: async (words) => matchesGitCommit(words),
    },
    {
        id: 'git-push',
        purpose: 'push a task branch you own to a configured remote',
        canary: 'git -C C:/canary push -u origin t1-canary',
        preToolUse: false,
        match: matchesGitPush,
    },
];
/** The route `line` runs, when it is one plain command an entry matches; else undefined. */
export async function routeOf(line, context) {
    const words = plainWordsOf(line);
    if (words === undefined) {
        return undefined;
    }
    for (const route of SANCTIONED_ROUTES) {
        if (await route.match(words, context)) {
            return route;
        }
    }
    return undefined;
}
