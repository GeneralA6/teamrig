import { weekLine } from "../../budget/report.js";
import { LeadTree } from "../../config/lead-tree.js";
import { errorMessage } from "../../core/guards.js";
import { KIT_NAME } from "../../core/home.js";
import { blockStartLines, liveTasksNote } from "../../hooks/live-tasks.js";
import { MeetingSchedule } from "../../meeting/schedule.js";
import { heldFirst } from "../../register/leader-wait.js";
import { JsonlEventLog } from "../../register/store.js";
import { TaskTree } from "../../register/tree.js";
import { teamZone } from "../kit.js";
import { readStoredWeek } from "../stored-week.js";
import { teamRanking } from "../team-ranking.js";
import { KitTreeTasks } from "../tree-tasks.js";
import { startMeetingLine } from "./meetings.js";
/**
 * Session `id`'s live-task block for its start note (hooks/live-tasks.ts) after `start`'s first lines read at this start
 * (`start`), which make the note the work block's start, its times in the team's `zone`, from the working set of the team's register
 * log and of its tree's other registers, which a wait on one of their tasks reads (T1139): no lock and no archive (a
 * compaction retires only finished tasks), so the hook can afford it. It ranks as `list` does, so the note and the list
 * agree on the order: that reads the use as last stored, as `blockStartOf` does, with no transcript measured. A register
 * it cannot read gives one line that says so and names the command that lists the tasks, never a throw: the handover no
 * longer restates statuses, so the session must learn where to read them, and the note must still reach it; that note
 * is no work block's start.
 */
export async function liveTasksNoteOf(runtime, paths, config, id, zone, start) {
    try {
        const [{ state }, elsewhere] = await Promise.all([new JsonlEventLog(runtime.files, paths.events).read(), new KitTreeTasks(runtime, paths.team).read()]);
        const ranking = await teamRanking(runtime, paths, config, state.tasks.values());
        const now = runtime.clock.now();
        const tree = new TaskTree(state.tasks, new Date(now), zone, undefined, elsewhere, ranking);
        // No parent lead here: a hold counts only when it names this session, and a wait on the team above never does.
        const waiting = heldFirst(tree.waitingOn(id), id, new LeadTree(config), config.focus, now);
        return [...blockStartLines(id, start, KIT_NAME), liveTasksNote({ tasks: state.tasks.values(), owner: id, tree, waiting, command: KIT_NAME })].join('\n');
    }
    catch (error) {
        return `LIVE TASKS: ${KIT_NAME} could not read the register (${errorMessage(error)}); run \`${KIT_NAME} list --session ${id}\` for your tasks.`;
    }
}
/**
 * What `start` prints before session `id`'s task list, for its start note: the time on the team's clock, today's and
 * the missed meetings it is met in or joins (every one for the lead), and the week as a hook reads it (cli/stored-week.ts:
 * the use as last stored, no transcript measured, so a restore of many tabs stays inside the hook's timeout). A
 * schedule or a week it cannot read leaves its line out, never throws: the note must still reach the session.
 */
export async function blockStartOf(runtime, kit, config, id) {
    const zone = teamZone(config, runtime);
    const now = runtime.clock.now();
    const lead = new LeadTree(config).lead;
    const [meetings, week] = await Promise.all([
        new MeetingSchedule(runtime.files, kit.paths.meetings)
            .read()
            .then((schedule) => startMeetingLine(schedule.meetings, zone, now, id, id === lead))
            .catch(() => undefined),
        readStoredWeek(runtime, kit.paths, config, now)
            .then((reading) => weekLine(reading, zone))
            .catch(() => undefined),
    ]);
    return { at: zone.weekdayMinute(new Date(now)), meetings, week };
}
