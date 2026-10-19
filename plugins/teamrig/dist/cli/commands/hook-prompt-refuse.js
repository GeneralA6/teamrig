import { isRecord } from "../../core/guards.js";
import { hookAsksOf } from "../../hooks/permission.js";
import { promptRefusedReason, promptRefuseOutput, refusedTool } from "../../hooks/prompt-refuse.js";
import { noPositionals } from "../args.js";
import { openKit } from "../kit.js";
import { EXIT } from "../runtime.js";
import { parseJson, sessionTeam } from "./hook-input.js";
/** What the hook prints for this payload: the refusal with its reason, or '' when the prompt opens. */
async function promptRefuseOutputOf(runtime, payload) {
    const found = await sessionTeam(payload, runtime);
    if (found.kind !== 'team') {
        return '';
    }
    const kit = await openKit(runtime, found.team);
    const tool = refusedTool(hookAsksOf(kit.load), payload);
    return tool === undefined ? '' : promptRefuseOutput(promptRefusedReason(tool));
}
/**
 * PermissionRequest: under `prompts.hookAsks: refuse` in the team config, refuses the permission prompt Claude Code is
 * about to raise, with a reason that says to record the step as waiting for the owner and take the next task. Outside a
 * team, with asks on or the config missing or broken, for the question picker or plan mode's exit, for input that is
 * not a hook payload or on any error, it prints nothing, so the prompt opens.
 */
export async function promptRefuse(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const output = isRecord(payload) ? await promptRefuseOutputOf(runtime, payload).catch(() => '') : '';
    if (output !== '') {
        runtime.out.stdout(output);
    }
    return EXIT.ok;
}
