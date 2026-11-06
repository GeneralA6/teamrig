import { weekLine } from '../../budget/report.ts';
import { LeadTree } from '../../config/lead-tree.ts';
import type { KitConfig } from '../../config/types.ts';
import { errorMessage } from '../../core/guards.ts';
import { KIT_NAME, type TeamPaths } from '../../core/home.ts';
import type { TimeZone } from '../../core/zone.ts';
import { blockStartLines, liveTasksNote, type BlockStart } from '../../hooks/live-tasks.ts';
import { MeetingSchedule } from '../../meeting/schedule.ts';
import { JsonlEventLog } from '../../register/store.ts';
import { TaskTree } from '../../register/tree.ts';
import { teamZone, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { readStoredWeek } from '../stored-week.ts';
import { teamRanking } from '../team-ranking.ts';
import { KitTreeTasks } from '../tree-tasks.ts';
import { startMeetingLine } from './meetings.ts';

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
export async function liveTasksNoteOf(runtime: CliRuntime, paths: TeamPaths, config: KitConfig, id: string, zone: TimeZone, start: BlockStart): Promise<string> {
  try {
    const [{ state }, elsewhere] = await Promise.all([new JsonlEventLog(runtime.files, paths.events).read(), new KitTreeTasks(runtime, paths.team).read()]);
    const ranking = await teamRanking(runtime, paths, config, state.tasks.values());
    const tree = new TaskTree(state.tasks, new Date(runtime.clock.now()), zone, undefined, elsewhere, ranking);
    return [...blockStartLines(id, start, KIT_NAME), liveTasksNote({ tasks: state.tasks.values(), owner: id, tree, command: KIT_NAME })].join('\n');
  } catch (error) {
    return `LIVE TASKS: ${KIT_NAME} could not read the register (${errorMessage(error)}); run \`${KIT_NAME} list --session ${id}\` for your tasks.`;
  }
}

/**
 * What `start` prints before session `id`'s task list, for its start note: the time on the team's clock, today's and
 * the missed meetings it is met in or joins (every one for the lead), and the week as a hook reads it (cli/stored-week.ts:
 * the use as last stored, no transcript measured, so a restore of many tabs stays inside the hook's timeout). A
 * schedule or a week it cannot read leaves its line out, never throws: the note must still reach the session.
 */
export async function blockStartOf(runtime: CliRuntime, kit: Kit, config: KitConfig, id: string): Promise<BlockStart> {
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
