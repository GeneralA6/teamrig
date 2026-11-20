import { ServedText, type Cut, type SecretShapes } from './text.ts';

/** Where a booked meeting stands. */
export type ServedMeetingStatus = 'scheduled' | 'started' | 'done' | 'dropped';

/** One meeting of the owner with a session, as the `meetings` document serves it. */
export interface ServedMeeting {
  /** `M<n>`, numbered per team. */
  readonly id: string;
  /** When it starts, as an ISO instant. */
  readonly at: string;
  /** The same moment as the team reads it, in its own zone. */
  readonly atText: string;
  readonly minutes: number;
  /** The session met, by id. */
  readonly session: string;
  /** Other sessions joining, by id. */
  readonly with: readonly string[];
  /** The tasks it settles, by id. */
  readonly tasks: readonly string[];
  /** What it is about: the team's own words, since no connector writes a meeting. */
  readonly about: string;
  /** The brief's file, named as the command serves a path; null when the meeting has none. */
  readonly brief: string | null;
  readonly status: ServedMeetingStatus;
  /**
   * Still scheduled although its slot was over when the document was built. It moves with the clock while no file
   * changes, and the clock is no part of the revision: a reader holding an unchanged revision reads it again as
   * `status` being `scheduled` and `at` plus `minutes` being past.
   */
  readonly missed: boolean;
}

/** The `meetings` document's own fields. */
export interface MeetingsBody {
  readonly meetings: readonly ServedMeeting[];
  readonly cuts: readonly Cut[];
}

/**
 * A meeting as it is handed in: a row of `meetingRows` (src/meeting/rows.ts) fits it as it is. It is declared here
 * and not imported, since that file reaches the disk's own module and nothing in this folder may.
 */
export type MeetingInput = ServedMeeting;

/** What the `meetings` document is built from. */
export interface MeetingsInput {
  /** The meetings to serve, in the order to serve them; a `brief` already named as a served path. */
  readonly rows: readonly MeetingInput[];
  readonly shapes: SecretShapes;
}

/**
 * The `meetings` document's body. Every text a person typed, or that a hand-edited file may hold, is looked at for a
 * secret's shape, each element of a list by itself, so one cut never takes its neighbours with it.
 */
export function meetingsBody(input: MeetingsInput): MeetingsBody {
  const served = new ServedText(input.shapes);
  const meetings = input.rows.map((row): ServedMeeting => ({
    id: row.id,
    at: row.at,
    atText: row.atText,
    minutes: row.minutes,
    session: served.plain(row.id, 'session', row.session),
    with: row.with.map((session) => served.plain(row.id, 'with', session)),
    tasks: row.tasks.map((task) => served.plain(row.id, 'tasks', task)),
    about: served.plain(row.id, 'about', row.about),
    brief: served.plainOrNull(row.id, 'brief', row.brief),
    status: row.status,
    missed: row.missed,
  }));
  return { meetings, cuts: served.cuts };
}
