import type { KitConfig } from '../../config/types.ts';
import { LockBusyError } from '../../core/lock.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { postLine } from '../../inbox/inbox.ts';
import { dueStage, nextStageAt, type NoticeStage } from '../../meeting/notice-stage.ts';
import { noticeOf, showNotice, type MeetingNotice } from '../../meeting/notify.ts';
import { MeetingSchedule, type ScheduledMeeting } from '../../meeting/schedule.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import type { Kit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { parseJson } from './hook-input.ts';
import { inboxDepsOf } from './inbox.ts';
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

/** A meeting and the stage of it due now. */
interface DueMeeting {
  readonly meeting: ScheduledMeeting;
  readonly stage: NoticeStage;
}

interface Marked {
  readonly due: readonly DueMeeting[];
  readonly recheckAt: number | null;
}

function answer(runtime: CliRuntime, value: MeetingDueAnswer): ExitCode {
  runtime.out.stdout(JSON.stringify(value));
  return EXIT.ok;
}

function dueOf(meetings: readonly ScheduledMeeting[], now: number, config: KitConfig): DueMeeting[] {
  return meetings.flatMap((meeting) => {
    const stage = dueStage(meeting, now, config.meetingNotices);
    return stage === undefined ? [] : [{ meeting, stage }];
  });
}

/** Marks each meeting with a stage due now as notified, under the lock held; those meetings, and the next stage's time. */
async function markDue(schedule: MeetingSchedule, now: number, config: KitConfig): Promise<Marked> {
  const { meetings } = await schedule.read();
  const due = dueOf(meetings, now, config);
  const marked = new Set(due.map(({ meeting }) => meeting.id));
  for (const { meeting } of due) {
    await schedule.write({ ...meeting, notifiedAt: now }, now);
  }
  const after = meetings.map((meeting) => (marked.has(meeting.id) ? { ...meeting, notifiedAt: now } : meeting));
  return { due, recheckAt: nextStageAt(after, now, config.meetingNotices) };
}

/** The lead's inbox line of a missed meeting; a refusal (a secret pattern in its words) goes to stderr, never stops the notices. */
async function tellLead(runtime: CliRuntime, kit: Kit, config: KitConfig, from: string, notice: MeetingNotice, now: number): Promise<void> {
  const problem = await postLine(inboxDepsOf(runtime, kit.paths).inboxes, new SecretScanner(config.register.secretPatterns), {
    to: config.roles.lead,
    from,
    text: `${notice.title}: ${notice.text}`,
    now: new Date(now),
  });
  if (problem !== undefined) {
    runtime.out.stderr(`meeting ${notice.id}: the inbox line to ${config.roles.lead} was not posted: ${problem}`);
  }
}

/**
 * `hook meeting-due`, run by the mod's MeetingHand in every open tab of the team once the meetings file changed or
 * the time it was told came (T1358, T2405). Each scheduled meeting with a notice stage due (`meetingNotices`: before
 * its slot, at it, missed after it) is marked notified under the meetings lock, so only one tab sends it: the OS
 * notification starts hidden (`osToast`), the tab shows it (`tabToast`), and a missed one goes to the lead's inbox
 * (`leadInbox`). A busy lock is asked again at the mod's next look.
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
  if (dueOf(meetings, now, config).length === 0) {
    return answer(runtime, { kind: 'due', notices: [], watch, recheckAt: nextStageAt(meetings, now, config.meetingNotices) });
  }
  let marked: Marked;
  try {
    marked = await fileLockOf(runtime, kit.paths.meetingsLock, config.lock).run(() => markDue(schedule, now, config));
  } catch (error) {
    if (error instanceof LockBusyError) {
      return answer(runtime, { kind: 'due', notices: [], watch, recheckAt: now });
    }
    throw error;
  }
  const settings = config.meetingNotices;
  const notices = marked.due.map(({ meeting, stage }) => noticeOf(meeting, stage, now));
  for (const notice of notices) {
    if (settings.osToast) {
      await showNotice(runtime.processes, runtime.platform, notice, runtime.env, runtime.cwd);
    }
    if (notice.stage === 'missed' && settings.leadInbox) {
      await tellLead(runtime, kit, config, scope.id, notice, now);
    }
  }
  return answer(runtime, { kind: 'due', notices: settings.tabToast ? notices : [], watch, recheckAt: marked.recheckAt });
}
