import { toJsonlLine } from "../../core/jsonl.js";
import { SecretScanner } from "../../core/secrets.js";
import { hookAsksOf } from "../../hooks/permission.js";
import { promptAnswerOf, promptAnswerRecord, promptAnswerReply, refusedCall } from "../../hooks/prompt-refuse.js";
import { callReads } from "../../hooks/readonly-shell.js";
import { noPositionals } from "../args.js";
import { hookLogOf } from "../hook-logs.js";
import { openKit } from "../kit.js";
import { EXIT } from "../runtime.js";
import { envSession, readHookInput, sessionTeam, writeReply } from "./hook-input.js";
import { readonlyCheckOf } from "./hook-readonly-allow.js";
import { callRouteOf } from "./hook-route-context.js";
/**
 * The hook's reply to this event: the answer for its case (an allow for a sanctioned route or a read-only line, else a
 * refusal with its reason), or none when the prompt opens. Each answer is logged to the team's prompt answers.
 */
async function promptRefuseReplyOf(runtime, event, deps) {
    const found = await sessionTeam(event.cwd, runtime);
    if (found.kind !== 'team') {
        return undefined;
    }
    const kit = await openKit(runtime, found.team);
    const call = refusedCall(hookAsksOf(kit.load), event);
    if (call === undefined || kit.load.status !== 'loaded') {
        return undefined;
    }
    const route = await callRouteOf(runtime, kit, kit.load.config, event, deps.table);
    // The prompt would wait for a person under refuse, so a provably read-only line runs even with the read-only allow off.
    const check = await readonlyCheckOf(runtime, kit.load.config);
    const answer = promptAnswerOf(call, () => callReads(event, check.rules, check.printsSecret), route?.id);
    const facts = { at: new Date(runtime.clock.now()), session: envSession(runtime), claudeSession: event.session ?? null, call, answer };
    const record = promptAnswerRecord(facts, new SecretScanner(kit.load.config.register.secretPatterns));
    // Best effort: the log feeds the daily triage, and a full disk or a held lock must not turn the answer into an open prompt.
    await hookLogOf(runtime, kit.paths, 'prompt-answers').append(toJsonlLine(record)).catch(() => undefined);
    return promptAnswerReply(call.name, answer);
}
/**
 * PermissionRequest: under `prompts.hookAsks: refuse` in the team config, answers the permission prompt Claude Code is
 * about to raise, per case (hooks/prompt-refuse.ts): a Bash line that runs a sanctioned route (permissions/sanctioned.ts)
 * or provably only reads runs; a line teamrig's rules give a rerun form is refused quoting it; anything else is refused
 * with a reason that says to record the step as waiting for the owner and take the next task. It logs each answer to
 * `state/prompt-answers.jsonl`, its command masked (hooks/log-mask.ts), a route's only by its id; the log's records
 * over a week old move to `state/archive/` (cli/hook-logs.ts). Outside a team, with asks on or the config missing or
 * broken, for the question picker or plan mode's exit, for input that is not a hook payload or on any error, it prints
 * nothing, so the prompt opens.
 */
export function promptRefuse(deps) {
    return async (args, runtime) => {
        noPositionals(args);
        const { event } = await readHookInput(runtime);
        const reply = event === undefined ? undefined : await promptRefuseReplyOf(runtime, event, deps).catch(() => undefined);
        writeReply(runtime, 'permission-prompt', reply);
        return EXIT.ok;
    };
}
