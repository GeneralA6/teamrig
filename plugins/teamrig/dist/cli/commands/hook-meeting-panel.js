import { askedDecisions, bookedDecisions } from "../../meeting/agenda.js";
import { meetingPanelOf } from "../../meeting/panel.js";
import { bookedMeetingOf, MeetingSchedule } from "../../meeting/schedule.js";
import { inMeeting, MeetingStore } from "../../meeting/state.js";
import { noPositionals } from "../args.js";
import { subtreeOf } from "../roll-up.js";
import { EXIT } from "../runtime.js";
import { loadTree } from "../tree.js";
import { readHookInput } from "./hook-input.js";
import { wakeScopeOf } from "./hook-wake.js";
import { agendaRegisterOf, decidedByOf, decisionAgendaOf } from "./meeting-registers.js";
function answer(runtime, value) {
    runtime.out.stdout(JSON.stringify(value));
    return EXIT.ok;
}
/** The ids a booked meeting covers: its tasks and every task they need first, directly or not, each once. */
export function bookedTaskIds(tasks, tree) {
    const found = new Set();
    const queue = [...tasks];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        if (!found.has(next)) {
            found.add(next);
            queue.push(...tree.needs(next));
        }
    }
    return found;
}
/**
 * The panel of a booked meeting started in this tab's session (T2808), in any team: the owner's cards among the
 * meeting's tasks and those they need, of the session's own register, as bookedDecisions asks them, the ones the
 * session recorded a decision on since the start checked off.
 */
async function bookedPanel(runtime, { kit, config, roster, id }, booked) {
    const { own } = await subtreeOf(runtime, { kit, config, roster }, await loadTree(runtime));
    const register = agendaRegisterOf(own, runtime);
    const ids = bookedTaskIds(booked.tasks, register.tree);
    const tasks = register.tasks.filter((task) => ids.has(task.id));
    const panel = meetingPanelOf({
        meeting: { startedAt: new Date(booked.changedAt).toISOString() },
        registers: [{ team: undefined, tasks, decidedBy: id }],
        asked: bookedDecisions({ ...register, tasks }),
        ownerMarker: config.register.ownerSource,
    });
    return { kind: 'open', ...panel, watch: [kit.paths.meetings, own.paths.events] };
}
/**
 * `hook meeting-panel`, run by the mod's meeting panel hand in a team session's tab (T2512), only with
 * `meeting.panel.enabled`. A booked meeting (`meeting start M<n>`) started in this session's tab shows its own cards
 * (bookedPanel, T2808). Otherwise it shows only in the tab of a team's lead, a sub-team's too (T2985), while the
 * meeting it started is open: the owner's cards of the lead's register and of every team under it, as the agenda asks
 * them, the ones decided since the start checked off (meetingPanelOf). It reads and writes nothing else.
 */
export async function meetingPanel(args, runtime) {
    noPositionals(args);
    const scope = await wakeScopeOf(runtime, (await readHookInput(runtime)).event, false);
    if (scope.kind === 'off') {
        return answer(runtime, { ...scope, watch: [] });
    }
    const { kit, config, roster, id } = scope;
    if (!config.meeting.panel.enabled) {
        return answer(runtime, { kind: 'off', why: 'meeting.panel.enabled is false', watch: [] });
    }
    const now = runtime.clock.now();
    const { meetings } = await new MeetingSchedule(runtime.files, kit.paths.meetings).read();
    const booked = bookedMeetingOf(meetings.filter((meeting) => meeting.session === id), id, now);
    if (booked !== undefined) {
        return answer(runtime, await bookedPanel(runtime, { kit, config, roster, id }, booked));
    }
    if (roster.holderOf('lead') !== id) {
        return answer(runtime, { kind: 'off', why: 'no meeting of yours is started', watch: [kit.paths.meetings] });
    }
    const meeting = await new MeetingStore(runtime.files, kit.paths.meeting).read();
    if (meeting === undefined || !inMeeting(meeting, id, now)) {
        return answer(runtime, { kind: 'off', why: 'no meeting is open', watch: [kit.paths.meeting, kit.paths.meetings] });
    }
    const rollUp = await subtreeOf(runtime, { kit, config, roster }, await loadTree(runtime));
    const { own, teams } = rollUp;
    const panel = meetingPanelOf({
        meeting,
        registers: teams.map((rolled) => ({
            team: rolled.team === own.team ? undefined : rolled.team,
            tasks: [...rolled.snapshot.state.tasks.values()],
            decidedBy: decidedByOf(rolled, own, id),
        })),
        asked: askedDecisions(decisionAgendaOf(rollUp, runtime, now, meeting.carried)),
        ownerMarker: config.register.ownerSource,
    });
    return answer(runtime, { kind: 'open', ...panel, watch: [kit.paths.meeting, kit.paths.meetings, ...teams.map((rolled) => rolled.paths.events)] });
}
