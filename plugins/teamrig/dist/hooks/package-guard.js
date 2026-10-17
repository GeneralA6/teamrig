import { DEFAULT_PACKAGE_GUARD } from "../config/defaults.js";
import { isRecord, recordField, stringField } from "../core/guards.js";
import { adHocCallsOf } from "../package-guard/ad-hoc.js";
/** What an ad-hoc package run gets. A missing or unreadable config keeps the default, so a broken config never switches the guard off. */
export function adHocRunnersOf(load) {
    return load?.status === 'loaded' ? load.config.packageGuard.adHocRunners : DEFAULT_PACKAGE_GUARD.adHocRunners;
}
/** Why the calls are refused or asked about, with the vetted route to the same tool. */
export function adHocReason(calls) {
    const named = calls.map((call) => `\`${call}\``).join(', ');
    const verb = calls.length === 1 ? 'fetches and runs a package' : 'fetch and run packages';
    return (`teamrig package guard: ${named} ${verb} outside the project's lockfile, unvetted. Vet the exact version first ` +
        '(publish date, advisories), add it as a pinned devDependency, then run its local bin (npx --no <bin>). [packageGuard.adHocRunners]');
}
/**
 * The PreToolUse output for a Bash or PowerShell call: a refusal (or a question, as `packageGuard.adHocRunners`
 * says) when the line runs a package ad hoc, else nothing, so the normal permission flow decides.
 */
export async function packageGuardOutput(payload, env) {
    if (env.adHocRunners === 'allow' || !isRecord(payload)) {
        return '';
    }
    const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
    if (command === undefined) {
        return '';
    }
    const context = {
        cwd: stringField(payload, 'cwd') ?? env.cwd,
        home: env.home,
        dialect: stringField(payload, 'tool_name') === 'PowerShell' ? 'powershell' : 'bash',
    };
    const calls = await adHocCallsOf(command, context, env.files);
    if (calls.length === 0) {
        return '';
    }
    return JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: env.adHocRunners, permissionDecisionReason: adHocReason(calls) },
    });
}
