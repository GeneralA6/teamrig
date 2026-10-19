import { isRecord } from "../../core/guards.js";
import { KIT_NAME } from "../../core/home.js";
import { guardsPicker, pickerGuardOutput, pickerReason, refusesSession } from "../../hooks/picker-guard.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { noPositionals } from "../args.js";
import { openKit, rosterOf } from "../kit.js";
import { EXIT } from "../runtime.js";
import { parseJson, sessionTeam, teamSessionOf } from "./hook-input.js";
/**
 * The team session whose question picker the guard refuses (hooks/picker-guard.ts); undefined lets the call go. The
 * session is read only for a picker call with the switch on, so the tab-status hook's other events read no file.
 */
export async function refusedPickerSession(runtime, kit, config, payload) {
    if (!guardsPicker(config.pickerGuard.enabled, payload)) {
        return undefined;
    }
    const session = await teamSessionOf(runtime, kit, await rosterOf(runtime, kit, config), sessionIdOf(payload));
    return refusesSession(session, config.roles.lead) ? session : undefined;
}
/** What the hook prints for this payload: the refusal with its reason, or '' when the picker opens. */
async function pickerGuardOutputOf(runtime, payload) {
    const found = await sessionTeam(payload, runtime);
    const kit = found.kind === 'team' ? await openKit(runtime, found.team) : undefined;
    if (kit?.load.status !== 'loaded') {
        return '';
    }
    const session = await refusedPickerSession(runtime, kit, kit.load.config, payload);
    return session === undefined ? '' : pickerGuardOutput(pickerReason(KIT_NAME, session));
}
/**
 * PreToolUse on AskUserQuestion: with `pickerGuard.enabled`, refuses the question picker to every team session but
 * the lead, with a reason that says to record the decision on its task and go on with the next one. Outside a team,
 * with the guard off, for the lead, a tab that is no team session, input that is not a hook payload or on any error,
 * it prints nothing, so the picker opens.
 */
export async function pickerGuard(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const output = isRecord(payload) ? await pickerGuardOutputOf(runtime, payload).catch(() => '') : '';
    if (output !== '') {
        runtime.out.stdout(output);
    }
    return EXIT.ok;
}
