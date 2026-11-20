import { isAbsolute, posix, win32 } from 'node:path';
import { SecretScanner } from '../../core/secrets.ts';
import { meetingsBody } from '../../interface/index.ts';
import { meetingRows } from '../../meeting/rows.ts';
import { MeetingSchedule } from '../../meeting/schedule.ts';
import { teamZone } from '../kit.ts';
import { belowOf, servedPathOf, stampsOf, type DocumentSource, type ReadScope, type ServedFolder } from './read-source.ts';

/** Either OS's separator: a brief typed on one OS is read on another when a team's folder is shared. */
const SEPARATORS = /[\\/]+/;

/**
 * How a meeting's brief is named. It is a path a person typed at the booking, stored as typed and never checked:
 * - one that is not a full path on any OS is served as typed, since it is the team's own words and holds no home;
 * - a full path inside the team's folder is named from that folder down, as a problem names a file;
 * - any other full path is named by its last part alone, since the rest is a place on someone's disk. A path that
 *   is full only on the other OS (`C:\...` read on Linux) is one of these: this OS's own reading of it would take
 *   the whole of it for one file's name, or for a path below the folder the run was started in.
 */
export function servedBriefOf(folder: ServedFolder, brief: string): string {
  if (!win32.isAbsolute(brief) && !posix.isAbsolute(brief)) {
    return brief;
  }
  if (isAbsolute(brief) && belowOf(folder, brief) !== undefined) {
    return servedPathOf(folder, brief);
  }
  return brief.split(SEPARATORS).filter((part) => part !== '').at(-1) ?? '';
}

/**
 * `meetings`: the owner's scheduled and started meetings of the team, by time, as `meeting list --json` prints
 * them. It reads the config (the zone, the secret shapes) and the meetings file. The clock is no part of its
 * revision: `missed` turns true when a slot ends with no file changing, so a reader holding an unchanged revision
 * reads it again from `status`, `at` and `minutes`.
 */
export function meetingsSource(scope: ReadScope): DocumentSource {
  const { runtime, kit, config } = scope;
  const zone = teamZone(config, runtime);
  return {
    async parts() {
      return {
        document: 'meetings',
        args: [
          ['team', kit.paths.team],
          ['zone', zone.name],
        ],
        stamps: await stampsOf(runtime, [kit.load.path, kit.paths.meetings]),
      };
    },
    async build() {
      const { meetings, skipped } = await new MeetingSchedule(runtime.files, kit.paths.meetings).read();
      const rows = meetingRows({ meetings, all: false, now: runtime.clock.now(), atText: (at) => zone.weekdayMinute(at) });
      const body = meetingsBody({
        rows: rows.map((row) => ({ ...row, brief: row.brief === null ? null : servedBriefOf(kit.paths, row.brief) })),
        shapes: new SecretScanner(config.register.secretPatterns),
      });
      const problems = skipped > 0 ? [`${servedPathOf(kit.paths, kit.paths.meetings)}: ${skipped} damaged or newer line(s) left out`] : [];
      return { body, problems };
    },
  };
}
