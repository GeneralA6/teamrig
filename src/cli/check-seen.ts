import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isStringArray } from '../core/guards.ts';
import type { TeamPaths } from '../core/home.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import type { TimeZone } from '../core/zone.ts';
import type { CheckReport } from './reports.ts';

/**
 * What `start` and `check --new` last showed a session of the check flags (T2536, the T2217 F3 fix): one small file
 * per session, the keys of every flag in that report, replaced on each write. `check --new` prints only the flags
 * whose key is not in it, so a session reads a flag once in a block instead of on every check. The set is replaced,
 * not added to, so a flag that clears and comes back is new again. A plain `check` and `check --all` neither read nor
 * write it: they stay the full view.
 */

/** The format of the file this code reads and writes; a file in another format reads as nothing seen. */
export const CHECK_SEEN_FORMAT = 1;

/** The flag keys a session was last shown, and when. */
export interface SeenFlags {
  readonly at: number;
  readonly keys: ReadonlySet<string>;
}

/**
 * Each flag's key in a report: its kind and what it is on (a task with its team, a skill, a hired session or an area,
 * an unowned warning's own key), never its detail, which may change while the flag stands (an OVERDUE's days late).
 */
export function checkKeys(report: CheckReport): Set<string> {
  return new Set([
    ...report.sections.flatMap(({ team, flags }) => flags.map((flag) => taskFlagKey(flag.kind, team, flag.task.id))),
    ...report.skills.map((flag) => `skill ${flag.kind} ${flag.skill}`),
    ...report.hires.map((flag) => `hire ${flag.kind} ${flag.session}`),
    ...report.unowned.map((warning) => `unowned ${warning.key}`),
  ]);
}

function taskFlagKey(kind: string, team: string | undefined, task: string): string {
  return `task ${kind} ${team === undefined ? task : `${team}/${task}`}`;
}

/**
 * The report cut to the flags whose key `seen` lacks; the scope, the lead and the due batch of decisions stay as they
 * are, since the batch is no flag but the lead's next ask.
 */
export function newFlags(report: CheckReport, seen: ReadonlySet<string>): CheckReport {
  return {
    ...report,
    sections: report.sections.map((section) => ({ ...section, flags: section.flags.filter((flag) => !seen.has(taskFlagKey(flag.kind, section.team, flag.task.id))) })),
    skills: report.skills.filter((flag) => !seen.has(`skill ${flag.kind} ${flag.skill}`)),
    hires: report.hires.filter((flag) => !seen.has(`hire ${flag.kind} ${flag.session}`)),
    unowned: report.unowned.filter((warning) => !seen.has(`unowned ${warning.key}`)),
  };
}

/** The seen flags in a file's text; undefined when the text is damaged or from another format. */
export function parseCheckSeen(text: string): SeenFlags | undefined {
  const record = parseObject(text.trim());
  if (record === undefined || record[VERSION_FIELD] !== CHECK_SEEN_FORMAT) {
    return undefined;
  }
  const keys = record['keys'];
  const at = typeof record['at'] === 'string' ? Date.parse(record['at']) : Number.NaN;
  return isStringArray(keys) && !Number.isNaN(at) ? { at, keys: new Set(keys) } : undefined;
}

export function formatCheckSeen(seen: SeenFlags): string {
  return toJsonlLine({ [VERSION_FIELD]: CHECK_SEEN_FORMAT, at: new Date(seen.at).toISOString(), keys: [...seen.keys] });
}

/**
 * One session's seen flags, in `<dir>/<session>.json`. Only that session's own start and check write it, so it takes
 * no lock: two of its calls side by side leave one of the two sets, either of which it was shown.
 */
export class CheckSeen {
  private readonly files: Files;
  private readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  /** What was last seen; undefined for an absent or damaged file, so every flag counts as new. */
  async read(): Promise<SeenFlags | undefined> {
    const text = await this.files.read(this.path);
    return text === undefined ? undefined : parseCheckSeen(text);
  }

  /** Records `report`'s flags as seen at `at`, in place of the set before. */
  async record(report: CheckReport, at: number): Promise<void> {
    await this.files.write(this.path, formatCheckSeen({ at, keys: checkKeys(report) }));
  }
}

/** The seen flags of `session`, in the team's `checkSeen` folder. */
export function checkSeenOf(files: Files, paths: Pick<TeamPaths, 'checkSeen'>, session: string): CheckSeen {
  return new CheckSeen(files, join(paths.checkSeen, `${session}.json`));
}

/** `check --new`'s first line: since when its flags are new, or that none was recorded, so every flag shows. */
export function newSinceLine(session: string, seen: SeenFlags | undefined, zone: TimeZone): string {
  return seen === undefined
    ? `NEW every flag: no start or check --new of ${session} recorded what it showed yet`
    : `NEW since ${zone.weekdayMinute(new Date(seen.at))}, the last start or check --new of ${session} (check --all: every flag)`;
}
