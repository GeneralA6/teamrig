import { join } from 'node:path';
import { formatCount } from "../budget/format.js";
import { clipEnd } from "../core/clip.js";
import { isRecord } from "../core/guards.js";
import { jsonObjectOf } from "../doctor/settings-env.js";
import { hookCommandLine, hookCommandsOf } from "../doctor/settings-hooks.js";
import { countOf, formatCounts } from "../permissions/allow-rules.js";
import { planScope } from "../permissions/trim.js";
import { CONTEXT_HOOK_EVENTS, hookOutputKey } from "./scan-hook-output.js";
import { tokensOf } from "./scan-finding.js";
/** A hook's command prints up to this many characters. */
const HOOK_COMMAND_MAX_CHARS = 80;
function permissionsOf(settings) {
    const permissions = settings['permissions'];
    return isRecord(permissions) ? permissions : {};
}
function hasDeny(settings) {
    const deny = permissionsOf(settings)['deny'];
    return Array.isArray(deny) && deny.length > 0;
}
function wideFindings(plan) {
    const removed = countOf(plan.trim.removed);
    return removed === 0 ? [] : [{ kind: 'wide-allow', path: plan.file.path, what: `${removed} allow rule(s) approve a whole tool or hold a credential: ${formatCounts(plan.trim.removed)}` }];
}
/**
 * The context hooks of a settings file that the transcripts read show printing into the context, with what they
 * printed: a hook that never ran there, or printed nothing (a title, a guard), costs no context and is no finding.
 */
function hookFindings(path, settings, hooks, secrets) {
    return hookCommandsOf(settings, CONTEXT_HOOK_EVENTS).flatMap((hook) => {
        const output = hooks.get(hookOutputKey(hook.event, hook.command));
        if (output === undefined || output.printed === 0) {
            return [];
        }
        const shown = clipEnd(secrets.redact(hookCommandLine(hook)), HOOK_COMMAND_MAX_CHARS);
        const average = output.chars / output.runs;
        const printed = `printed ~${formatCount(average)} chars (~${formatCount(tokensOf(average))} tokens) a run on average over ${output.runs} run(s) read, something in ${output.printed}`;
        return [{ kind: 'context-hook', path, what: `${hook.event} hook "${shown}": ${printed}; it enters the context` }];
    });
}
function fileFindings(path, settings, hooks, secrets) {
    const bypass = permissionsOf(settings)['defaultMode'] === 'bypassPermissions' ? [{ kind: 'bypass', path, what: 'permissions.defaultMode is bypassPermissions: every tool call runs without asking' }] : [];
    return [...bypass, ...hookFindings(path, settings, hooks, secrets)];
}
/**
 * The settings findings of the Claude Code settings files in `scope`: per file, the allow rules a `permissions trim`
 * removes (counted by class, never printed), prompts turned off, and the context hooks `hooks` (the transcripts read)
 * show printing into the context, with what they printed, the same finding in a file's worktree copies folded into its
 * first, with their count; then one finding when no file denies anything. It only reads.
 */
export async function scanSettings(files, claudeDir, scope, keep, secrets, hooks) {
    /** Keyed by the file (a worktree's copy as the project folder's own), the kind and the words. */
    const found = new Map();
    let denies = false;
    for (const plan of await planScope(files, scope, keep, 'wide', secrets)) {
        if (plan.kind !== 'read') {
            continue;
        }
        const settings = jsonObjectOf(plan.text) ?? {};
        denies ||= hasDeny(settings);
        const file = plan.file.projectFile ?? plan.file.path;
        for (const finding of [...wideFindings(plan), ...fileFindings(plan.file.path, settings, hooks, secrets)]) {
            const key = JSON.stringify([file, finding.kind, finding.what]);
            const first = found.get(key);
            found.set(key, first === undefined ? { ...finding, copies: 0 } : { ...first, copies: first.copies + 1 });
        }
    }
    const grouped = [...found.values()];
    if (!denies) {
        grouped.push({ kind: 'no-deny', path: join(claudeDir, 'settings.json'), what: 'no settings file has a permissions.deny rule, so nothing is refused outright (secret files, force pushes)', copies: 0 });
    }
    return grouped;
}
