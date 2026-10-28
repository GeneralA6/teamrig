import { join } from 'node:path';
import { clipEnd } from "../core/clip.js";
import { isRecord } from "../core/guards.js";
import { jsonObjectOf } from "../doctor/settings-env.js";
import { hookCommandLine, hookCommandsOf } from "../doctor/settings-hooks.js";
import { countOf, formatCounts } from "../permissions/allow-rules.js";
import { planScope } from "../permissions/trim.js";
/** The hook events whose command output Claude Code adds to the session's context. */
export const CONTEXT_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit'];
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
function fileFindings(path, settings, secrets) {
    const found = [];
    if (permissionsOf(settings)['defaultMode'] === 'bypassPermissions') {
        found.push({ kind: 'bypass', path, what: 'permissions.defaultMode is bypassPermissions: every tool call runs without asking' });
    }
    for (const hook of hookCommandsOf(settings, CONTEXT_HOOK_EVENTS)) {
        const shown = clipEnd(secrets.redact(hookCommandLine(hook)), HOOK_COMMAND_MAX_CHARS);
        found.push({ kind: 'context-hook', path, what: `${hook.event} hook "${shown}": what it prints enters the context` });
    }
    return found;
}
/**
 * The settings findings of the Claude Code settings files in `scope`: per file, the allow rules a `permissions trim`
 * removes (counted by class, never printed), prompts turned off, and the hooks whose output enters every session's
 * context, the same finding in a file's worktree copies folded into its first, with their count; then one finding
 * when no file denies anything. It only reads.
 */
export async function scanSettings(files, claudeDir, scope, keep, secrets) {
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
        for (const finding of [...wideFindings(plan), ...fileFindings(plan.file.path, settings, secrets)]) {
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
