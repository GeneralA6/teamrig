import { join } from 'node:path';
import { clipEnd } from "../core/clip.js";
import { isRecord } from "../core/guards.js";
import { jsonObjectOf } from "../doctor/settings-env.js";
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
/** The `command` hooks of one event, in order. */
function hookCommands(settings, event) {
    const hooks = settings['hooks'];
    const groups = isRecord(hooks) && Array.isArray(hooks[event]) ? hooks[event] : [];
    const handlers = groups.flatMap((group) => (isRecord(group) && Array.isArray(group['hooks']) ? group['hooks'] : []));
    return handlers.flatMap((handler) => (isRecord(handler) && typeof handler['command'] === 'string' ? [handler['command']] : []));
}
function fileFindings(path, settings, secrets) {
    const found = [];
    if (permissionsOf(settings)['defaultMode'] === 'bypassPermissions') {
        found.push({ kind: 'bypass', path, what: 'permissions.defaultMode is bypassPermissions: every tool call runs without asking' });
    }
    for (const event of CONTEXT_HOOK_EVENTS) {
        for (const command of hookCommands(settings, event)) {
            const shown = clipEnd(secrets.redact(command), HOOK_COMMAND_MAX_CHARS);
            found.push({ kind: 'context-hook', path, what: `${event} hook "${shown}": what it prints enters the context` });
        }
    }
    return found;
}
/**
 * The settings findings of the Claude Code settings files in `scope`: per file, the allow rules a `permissions trim`
 * removes (counted by class, never printed), prompts turned off, and the hooks whose output enters every session's
 * context; then one finding when no file denies anything. It only reads.
 */
export async function scanSettings(files, claudeDir, scope, keep, secrets) {
    const found = [];
    let denies = false;
    for (const plan of await planScope(files, scope, keep, 'wide', secrets)) {
        if (plan.kind !== 'read') {
            continue;
        }
        const removed = countOf(plan.trim.removed);
        if (removed > 0) {
            found.push({ kind: 'wide-allow', path: plan.file.path, what: `${removed} allow rule(s) approve a whole tool or hold a credential: ${formatCounts(plan.trim.removed)}` });
        }
        const settings = jsonObjectOf(plan.text) ?? {};
        denies ||= hasDeny(settings);
        found.push(...fileFindings(plan.file.path, settings, secrets));
    }
    if (!denies) {
        found.push({ kind: 'no-deny', path: join(claudeDir, 'settings.json'), what: 'no settings file has a permissions.deny rule, so nothing is refused outright (secret files, force pushes)' });
    }
    return found;
}
