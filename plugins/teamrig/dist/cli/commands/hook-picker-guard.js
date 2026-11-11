import { isRecord } from "../../core/guards.js";
import { KIT_NAME } from "../../core/home.js";
import { helperOf } from "../../hooks/helper-start.js";
import { refusalOutput } from "../../hooks/permission.js";
import { askerOf, guardsPicker, pickerReason } from "../../hooks/picker-guard.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { MeetingStore, phaseOf } from "../../meeting/state.js";
import { noPositionals } from "../args.js";
import { openKit, rosterOf } from "../kit.js";
import { EXIT } from "../runtime.js";
import { loadTree } from "../tree.js";
import { parseJson, sessionTeam, teamSessionOf } from "./hook-input.js";
/** Whether the owner's daily meeting is open now (src/meeting/state.ts). */
async function meetingOpen(runtime, kit) {
    return phaseOf(await new MeetingStore(runtime.files, kit.paths.meeting).read(), runtime.clock.now()).kind === 'open';
}
/**
 * The team's parent lead when its config names a parent team, read from every team config (cli/tree.ts); undefined
 * for a team with no parent, or one whose parent has no config, which `doctor` names and the guard treats as a root.
 */
async function parentLeadOf(runtime, kit, config) {
    if (config.team?.parent === undefined) {
        return undefined;
    }
    const { tree } = await loadTree(runtime);
    return tree.placeOf(kit.paths.team)?.parentLead;
}
/**
 * Why the guard refuses this payload's question picker (hooks/picker-guard.ts); undefined lets the call go: the
 * switch is off, it is no picker call or no team session asks. The session is read only for a picker call with the
 * switch on, so the tab-status hook's other events read no file, and the team tree and the meeting, which only pick
 * the reason, only for the lead's own thread.
 */
export async function pickerRefusal(runtime, kit, config, payload) {
    if (!guardsPicker(config.pickerGuard.enabled, payload)) {
        return undefined;
    }
    const session = await teamSessionOf(runtime, kit, await rosterOf(runtime, kit, config), sessionIdOf(payload));
    const helper = helperOf(payload) !== undefined;
    const lead = config.roles.lead;
    const asker = askerOf(session, helper, lead, !helper && session === lead ? await parentLeadOf(runtime, kit, config) : undefined);
    if (asker === undefined) {
        return undefined;
    }
    const meeting = { open: asker.role === 'lead' && (await meetingOpen(runtime, kit)) };
    return pickerReason(KIT_NAME, asker, meeting);
}
/** What the hook prints for this payload: the refusal with its reason, or '' when the picker opens. */
async function pickerGuardOutputOf(runtime, payload) {
    const found = await sessionTeam(payload, runtime);
    const kit = found.kind === 'team' ? await openKit(runtime, found.team) : undefined;
    if (kit?.load.status !== 'loaded') {
        return '';
    }
    const reason = await pickerRefusal(runtime, kit, kit.load.config, payload);
    return reason === undefined ? '' : refusalOutput(reason);
}
/**
 * PreToolUse on AskUserQuestion: with `pickerGuard.enabled`, refuses the question picker in every team session and
 * every helper, the lead's own thread and a sub-team's lead included, with a reason that says to decide it if it is
 * the caller's own, else record it as a decision card (a sub-team's lead also tells its parent lead) and go on with
 * the next task; the lead in the owner's daily meeting is told to ask the card in plain text. Outside a team, with the
 * guard off, for a tab that is no team session, input that is not a hook payload or on any error, it prints nothing,
 * so the picker opens.
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
