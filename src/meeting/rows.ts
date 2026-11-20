import { byTime, isMissed, isOpenMeeting, type MeetingStatus, type ScheduledMeeting } from './schedule.ts';

/** One meeting as `meeting list --json` prints it and the `meetings` document serves it. */
export interface MeetingRow {
  readonly id: string;
  /** When it starts, as an ISO instant. */
  readonly at: string;
  /** The same moment as the team reads it, in its own zone. */
  readonly atText: string;
  readonly minutes: number;
  /** The session met. */
  readonly session: string;
  /** Other sessions joining. */
  readonly with: readonly string[];
  /** The tasks it settles. */
  readonly tasks: readonly string[];
  readonly about: string;
  /** The brief's path as it was typed at the booking; null when it has none. */
  readonly brief: string | null;
  readonly status: MeetingStatus;
  /** Still scheduled although its slot is over. */
  readonly missed: boolean;
}

export interface MeetingRowsInput {
  readonly meetings: readonly ScheduledMeeting[];
  /** Also the meetings done or dropped; without it only the scheduled and started ones. */
  readonly all: boolean;
  /** Epoch ms: what `missed` is counted against. */
  readonly now: number;
  /** A start as the team reads it; the caller's, since the zone is the team's setting. */
  readonly atText: (at: Date) => string;
}

/** The meetings by time, one row each: the one list both `meeting list --json` and `read meetings` print. */
export function meetingRows(input: MeetingRowsInput): MeetingRow[] {
  const shown = byTime(input.all ? input.meetings : input.meetings.filter(isOpenMeeting));
  return shown.map((meeting) => {
    const at = new Date(meeting.at);
    return {
      id: meeting.id,
      at: at.toISOString(),
      atText: input.atText(at),
      minutes: meeting.minutes,
      session: meeting.session,
      with: meeting.with,
      tasks: meeting.tasks,
      about: meeting.about,
      brief: meeting.brief,
      status: meeting.status,
      missed: isMissed(meeting, input.now),
    };
  });
}
