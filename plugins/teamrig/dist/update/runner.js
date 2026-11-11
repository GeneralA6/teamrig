/**
 * The programs behind the update band (T2466), run through the kit's HookRunner (no shell, a time limit, the whole
 * process tree killed past it): git for the check, and Claude Code's own `plugin` commands for the update itself, so
 * the install lands exactly as `/plugin` would land it.
 */
import { succeeded } from "../deploy/hooks.js";
import { gitEnvironment } from "../core/git-run.js";
/** A git step of the check (a fetch of one commit is the longest, about 4 s on 11-11) is killed past this. */
export const GIT_TIMEOUT_MS = 60_000;
/** Claude Code's marketplace update clones or pulls a whole marketplace; past this it is killed and the update failed. */
export const APPLY_TIMEOUT_MS = 180_000;
/** git through `hooks`, never asking for a login (`GIT_TERMINAL_PROMPT=0`): a remote that wants one fails quietly. */
export function hookGit(hooks, env) {
    return {
        async run(cwd, args) {
            const lines = [];
            const end = await hooks.run({
                argv: ['git', ...args],
                cwd,
                env: { ...gitEnvironment(env), GIT_TERMINAL_PROMPT: '0' },
                timeoutMs: GIT_TIMEOUT_MS,
                onLine: (line) => lines.push(line),
            });
            return succeeded(end) ? lines.join('\n') : undefined;
        },
    };
}
/**
 * Updates `plugin` from `marketplace` the way `/plugin` does: the marketplace first, so Claude Code sees the newest
 * version, then the plugin. The tab runs the new version once it reloads its plugins.
 */
export async function applyUpdate(deps, plugin, marketplace) {
    const steps = [
        ['plugin', 'marketplace', 'update', marketplace],
        ['plugin', 'update', `${plugin}@${marketplace}`],
    ];
    for (const step of steps) {
        const lines = [];
        const end = await deps.hooks.run({
            argv: [deps.claude.command, ...deps.claude.prefix, ...step],
            cwd: deps.cwd,
            env: deps.env,
            timeoutMs: APPLY_TIMEOUT_MS,
            onLine: (line) => lines.push(line),
        });
        if (!succeeded(end)) {
            return { ok: false, step: `claude ${step.join(' ')}`, said: lines.join('\n').trim() };
        }
    }
    return { ok: true };
}
