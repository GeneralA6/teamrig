import { isRecord } from "../../core/guards.js";
import { KIT_NAME } from "../../core/home.js";
import { helperOf } from "../../hooks/helper-start.js";
import { askerOf, guardsPicker, pickerGuardOutput, pickerReason, refusesAsker } from "../../hooks/picker-guard.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { MeetingStore, phaseOf } from "../../meeting/state.js";
import { noPositionals } from "../args.js";
import { openKit, rosterOf } from "../kit.js";
import { EXIT } from "../runtime.js";
import { parseJson, sessionTeam, teamSessionOf } from "./hook-input.js";
/** Whether the owner's daily meeting is open now (src/meeting/state.ts). */
async function meetingOpen(runtime, kit) {
    return phaseOf(await new MeetingStore(runtime.files, kit.paths.meeting).read(), runtime.clock.now()).kind === 'open';
}
/**
 * Who the guard refuses the question picker to (hooks/picker-guard.ts); undefined lets the call go. The session is
 * read only for a picker call with the switch on, so the tab-status hook's other events read no file, and the
 * meeting only for the lead's own thread.
 */
export async function refusedPickerAsker(runtime, kit, config, payload) {
    if (!guardsPicker(config.pickerGuard.enabled, payload)) {
        return undefined;
    }
    const session = await teamSessionOf(runtime, kit, await rosterOf(runtime, kit, config), sessionIdOf(payload));
    const asker = askerOf(session, helperOf(payload) !== undefined, config.roles.lead);
    if (asker === undefined) {
        return undefined;
    }
    return refusesAsker(asker, asker.role === 'lead' && (await meetingOpen(runtime, kit))) ? asker : undefined;
}
/** What the hook prints for this payload: the refusal with its reason, or '' when the picker opens. */
async function pickerGuardOutputOf(runtime, payload) {
    const found = await sessionTeam(payload, runtime);
    const kit = found.kind === 'team' ? await openKit(runtime, found.team) : undefined;
    if (kit?.load.status !== 'loaded') {
        return '';
    }
    const asker = await refusedPickerAsker(runtime, kit, kit.load.config, payload);
    return asker === undefined ? '' : pickerGuardOutput(pickerReason(KIT_NAME, asker));
}
/**
 * PreToolUse on AskUserQuestion: with `pickerGuard.enabled`, refuses the question picker in every team session and
 * every helper, the lead's own thread too unless the owner's daily meeting is open, with a reason that says to
 * decide it if it is the caller's own, else record it as a decision card and go on with the next task. Outside a
 * team, with the guard off, for the lead in a meeting, a tab that is no team session, input that is not a hook
 * payload or on any error, it prints nothing, so the picker opens.
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
