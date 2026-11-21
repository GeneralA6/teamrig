import { bashLineReads } from "../readonly-shell/bash.js";
import { powershellLineReads } from "../readonly-shell/powershell.js";
import { prefixWords } from "../readonly-shell/rules.js";
/** Why the line ran without a prompt, as the host shows it. */
export const READONLY_REASON = 'teamrig read-only shell: every command in the line only reads. [readonlyShell]';
/**
 * The rules a team's config, the hook's environment and the shell snapshot give the check. The shell a call runs in
 * inherits the host's environment, the hook's too, then sources the snapshot, so a name either exports reaches every
 * program the line runs.
 */
export function readonlyRulesOf(config, env, snapshot) {
    return {
        prefixes: config.allowPrefixes.map(prefixWords),
        exported: new Set([...Object.keys(env), ...snapshot.names]),
        exportsAll: snapshot.all,
    };
}
/** Whether the line only reads, judged in the dialect of the shell that runs it. */
function lineReads(dialect, command, rules) {
    switch (dialect) {
        case 'bash':
            return bashLineReads(command, rules);
        case 'powershell':
            return powershellLineReads(command, rules);
    }
}
/**
 * True when the call is a shell line whose every command provably only reads, and none prints a secret. The line must
 * pass in each text its shell may run (the call's `readings`): where the host rewrites a line on its way to the shell,
 * a separator or backtick only the shell sees never runs a hidden command without a prompt.
 */
export function callReads(event, rules, printsSecret) {
    const { call } = event;
    if (call?.kind !== 'shell' || call.command === undefined) {
        return false;
    }
    return call.readings.every((text) => lineReads(call.dialect, text, rules)) && !printsSecret(event);
}
/**
 * The reply to a shell call about to run: an allow, which skips the permission prompt, when every command in the line
 * provably only reads and none prints a secret; else none, so the host's own permission check decides. It never
 * refuses or asks. The host ranks another hook's deny or ask, and its settings' deny and ask rules, above it. A line
 * that prints a secret is never allowed here, even when the team let the secret guard allow it or that guard failed:
 * reading a secret into the conversation always takes a prompt.
 */
export function readonlyShellReply(event, rules, printsSecret) {
    return callReads(event, rules, printsSecret) ? { verdict: { kind: 'allow', reason: READONLY_REASON } } : undefined;
}
