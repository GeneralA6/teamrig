import { DEFAULT_PACKAGE_GUARD } from "../config/defaults.js";
import { isRecord, recordField, stringField } from "../core/guards.js";
import { adHocCallsOf } from "../package-guard/ad-hoc.js";
import { lostFlagsOf } from "../package-guard/lost-flags.js";
import { holdBackOutput } from "./permission.js";
/** What an ad-hoc package run gets. A missing or unreadable config keeps the default, so a broken config never switches the guard off. */
export function adHocRunnersOf(load) {
    return load?.status === 'loaded' ? load.config.packageGuard.adHocRunners : DEFAULT_PACKAGE_GUARD.adHocRunners;
}
/** Why the calls are refused or asked about, with the vetted route to the same tool. */
export function adHocReason(calls) {
    const named = calls.map((call) => `\`${call}\``).join(', ');
    const verb = calls.length === 1 ? 'fetches and runs a package' : 'fetch and run packages';
    return (`teamrig package guard: ${named} ${verb} outside the project's lockfile, unvetted. Vet the exact version first ` +
        '(publish date, advisories), add it as a pinned devDependency, then run its local bin (npx --no -- <bin>). [packageGuard.adHocRunners]');
}
/** Why the npx calls are refused: each hands its bin's flag to npm, with the form that keeps it for the bin. */
export function lostFlagReason(lost) {
    const named = lost.map(({ bin, flag }) => `\`npx --no ${bin} ${flag}\` runs npm with ${flag}, not ${bin} (run \`npx --no -- ${bin} ${flag}\`)`);
    return `teamrig package guard: ${named.join('; ')}. npx takes the word after a bare --no as that option's value, so the flags after it go to npm; put -- after --no.`;
}
/** The ad-hoc runs in a line, refused or asked about as the team set, or undefined for none. */
async function adHocVerdict(command, context, files, decision) {
    const calls = await adHocCallsOf(command, context, files);
    return calls.length === 0 ? undefined : { decision, reason: adHocReason(calls) };
}
/**
 * The PreToolUse output for a Bash or PowerShell call: a refusal (or a question, as `packageGuard.adHocRunners`
 * says) when the line runs a package ad hoc, and a refusal whatever that key says when an npx call hands its bin's
 * flag to npm, as that line cannot run what it names; else nothing, so the normal permission flow decides. Under
 * `hookAsks: refuse` the question is a refusal instead, its reason saying what to do (see `holdBack`).
 */
export async function packageGuardOutput(payload, env) {
    if (!isRecord(payload)) {
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
    const adHoc = env.adHocRunners === 'allow' ? undefined : await adHocVerdict(command, context, env.files, env.adHocRunners);
    const lost = lostFlagsOf(command, context);
    const verdict = lost.length === 0 ? adHoc : { decision: 'deny', reason: [lostFlagReason(lost), ...(adHoc === undefined ? [] : [adHoc.reason])].join(' ') };
    if (verdict === undefined) {
        return '';
    }
    return holdBackOutput(verdict.decision, verdict.reason, env.hookAsks);
}
