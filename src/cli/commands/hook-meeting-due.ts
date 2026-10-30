import { LockBusyError } from '../../core/lock.ts';
import { noticeOf, showNotice, type MeetingNotice } from '../../meeting/notify.ts';
import { isNotifyDue, MeetingSchedule, nextNotifyAt, type ScheduledMeeting } from '../../meeting/schedule.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { parseJson } from './hook-input.ts';
import { wakeScopeOf } from './hook-wake.ts';
import { fileLockOf } from '../file-locks.ts';

/**
 * What `hook meeting-due` answers the plugin's mod, one JSON line: the notices it fired now, for the tab to show as
 * well, and to ask again once a file in `watch` changes or at `recheckAt` (epoch ms; null: no meeting waits for its
 * time); or nothing to do in this tab (`why`), which the mod asks again later all the same.
 */
export type MeetingDueAnswer =
  | { readonly kind: 'due'; readonly notices: readonly MeetingNotice[]; readonly watch: readonly string[]; readonly recheckAt: number | null }
  | { readonly kind: 'off'; readonly why: string };

interface Marked {
  readonly due: readonly ScheduledMeeting[];
  readonly recheckAt: number | null;
}

function answer(runtime: CliRuntime, value: MeetingDueAnswer): ExitCode {
  runtime.out.stdout(JSON.stringify(value));
  return EXIT.ok;
}

/** Marks each meeting due now as notified, under the lock held; the meetings marked, and the next one's time. */
async function markDue(schedule: MeetingSchedule, now: number): Promise<Marked> {
  const { meetings } = await schedule.read();
  const due = meetings.filter((meeting) => isNotifyDue(meeting, now));
  for (const meeting of due) {
    await schedule.write({ ...meeting, notifiedAt: now }, now);
  }
  return { due, recheckAt: nextNotifyAt(meetings, now) };
}

/**
 * `hook meeting-due`, run by the mod's MeetingHand in every open tab of the team once the meetings file changed or
 * the time it was told came (T1358). Each scheduled meeting whose time came, its slot not over, is marked notified
 * under the meetings lock, so only one tab fires it, and its OS notification starts hidden. One past its slot fires
 * nothing: `meeting list` shows it as missed. A busy lock is asked again at the mod's next look.
 */
export async function meetingDue(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const scope = await wakeScopeOf(runtime, parseJson(await runtime.readStdin()), false);
  if (scope.kind === 'off') {
    return answer(runtime, scope);
  }
  const { kit, config } = scope;
  const { files, clock } = runtime;
  const schedule = new MeetingSchedule(files, kit.paths.meetings);
  const watch = [kit.paths.meetings];
  const now = clock.now();
  const { meetings } = await schedule.read();
  if (!meetings.some((meeting) => isNotifyDue(meeting, now))) {
    return answer(runtime, { kind: 'due', notices: [], watch, recheckAt: nextNotifyAt(meetings, now) });
  }
  let marked: Marked;
  try {
    marked = await fileLockOf(runtime, kit.paths.meetingsLock, config.lock).run(() => markDue(schedule, now));
  } catch (error) {
    if (error instanceof LockBusyError) {
      return answer(runtime, { kind: 'due', notices: [], watch, recheckAt: now });
    }
    throw error;
  }
  const notices = marked.due.map(noticeOf);
  for (const notice of notices) {
    await showNotice(runtime.processes, runtime.platform, notice, runtime.env, runtime.cwd);
  }
  return answer(runtime, { kind: 'due', notices, watch, recheckAt: marked.recheckAt });
}
