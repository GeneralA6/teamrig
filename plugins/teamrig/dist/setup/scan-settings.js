import { formatCount } from "../budget/format.js";
import { clipEnd } from "../core/clip.js";
import { jsonObjectOf } from "../doctor/settings-env.js";
import { hookCommandLine, hookCommandsOf } from "../doctor/settings-hooks.js";
import { countOf, formatCounts } from "../permissions/allow-rules.js";
import { planScope } from "../permissions/trim.js";
import { CONTEXT_HOOK_EVENTS, hookOutputKey, recordedCommandOf } from "./scan-hook-output.js";
import { tokensOf } from "./scan-finding.js";
/** A hook's command prints up to this many characters. */
const HOOK_COMMAND_MAX_CHARS = 80;
function wideFindings(plan) {
    const removed = countOf(plan.trim.removed);
    return removed === 0 ? [] : [{ kind: 'wide-allow', path: plan.file.path, what: `${removed} allow rule(s) approve a whole tool or hold a credential: ${formatCounts(plan.trim.removed)}` }];
}
/**
 * The context hooks of a settings file, or of a plugin's hooks file named by its `<plugin>@<marketplace>`, that the
 * transcripts read show printing into the context, with what they printed: a hook that never ran there, or printed
 * nothing (a title, a guard), costs no context and is no finding.
 */
export function hookFindings(path, settings, hooks, secrets, plugin) {
    return hookCommandsOf(settings, CONTEXT_HOOK_EVENTS).flatMap((hook) => {
        const output = hooks.get(hookOutputKey(hook.event, recordedCommandOf(hook)));
        if (output === undefined || output.printed === 0) {
            return [];
        }
        const shown = clipEnd(secrets.redact(hookCommandLine(hook)), HOOK_COMMAND_MAX_CHARS);
        const average = output.chars / output.runs;
        const printed = `printed ~${formatCount(average)} chars (~${formatCount(tokensOf(average))} tokens) a run on average over ${output.runs} run(s) read, something in ${output.printed}`;
        const owner = plugin === undefined ? '' : ` of plugin ${plugin}`;
        return [{ kind: 'context-hook', path, what: `${hook.event} hook "${shown}"${owner}: ${printed}; it enters the context` }];
    });
}
function fileFindings(path, settings, reading, hooks, secrets) {
    const bypass = reading.bypass === undefined ? [] : [{ kind: 'bypass', path, what: `${reading.bypass}: every tool call runs without asking` }];
    return [...bypass, ...hookFindings(path, settings, hooks, secrets)];
}
/**
 * The settings findings of the host's settings files in `scope`: per file, the allow rules a `permissions trim`
 * removes (counted by class, never printed), prompts turned off, and the context hooks `hooks` (the transcripts read)
 * show printing into the context, with what they printed, the same finding in a file's worktree copies folded into its
 * first, with their count; then one finding when no file denies anything, on `userSettings`, the person's own settings
 * file, where a deny rule holds in every project. It only reads.
 */
export async function scanSettings(permissions, files, userSettings, scope, keep, secrets, hooks) {
    /** Keyed by the file (a worktree's copy as the project folder's own), the kind and the words. */
    const found = new Map();
    let denies = false;
    for (const plan of await planScope(permissions, files, scope, keep, 'wide', secrets)) {
        if (plan.kind !== 'read') {
            continue;
        }
        const settings = jsonObjectOf(plan.text) ?? {};
        const reading = permissions.read(settings);
        denies ||= reading.deny.length > 0;
        const file = plan.file.projectFile ?? plan.file.path;
        for (const finding of [...wideFindings(plan), ...fileFindings(plan.file.path, settings, reading, hooks, secrets)]) {
            const key = JSON.stringify([file, finding.kind, finding.what]);
            const first = found.get(key);
            found.set(key, first === undefined ? { ...finding, copies: 0 } : { ...first, copies: first.copies + 1 });
        }
    }
    const grouped = [...found.values()];
    if (!denies) {
        grouped.push({ kind: 'no-deny', path: userSettings, what: `no settings file has a ${permissions.denySetting} rule, so nothing is refused outright (secret files, force pushes)`, copies: 0 });
    }
    return grouped;
}
