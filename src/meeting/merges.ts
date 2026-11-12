import { formatAddress } from '../core/address.ts';
import type { TimeZone } from '../core/zone.ts';
import type { MergeLogRead, MergeRecord, SelfMerge } from '../merge/merge-log.ts';
import { listed, teamPart } from './agenda.ts';

/**
 * The meeting's digest of self-merges (T800 §2.2, T858): what `teamrig merge` merged with no approval since the
 * meeting before, read from the team's merges log and the logs of the teams under it (T2457). A self-merge only the
 * review check looked at (`review: checked`) is marked CHECK-CLEAN, as security samples those weekly; those list
 * first, so the row cap never hides one. A change a leader approved is left out: a leader saw it already.
 */

/** A merges log as read, and its path, which a `+N more` or count line names. */
export interface MergeLogAt {
  readonly log: MergeLogRead;
  readonly path: string;
}

/** The merges log of a team under the lead's, whose rows name its sessions `<team>/<session>`. */
export interface TeamMergeLog extends MergeLogAt {
  readonly team: string;
}

export interface MergeDigestInput {
  /** The lead's team's merges log. */
  readonly own: MergeLogAt;
  /**
   * The logs of the teams under the lead's, depth first, each path once: a team whose `delivery.dir` is the lead's
   * (or an earlier team's) shares that log, whose rows are read there already, so it has no entry here.
   */
  readonly below: readonly TeamMergeLog[];
  /** When the digest starts: the agenda's start (agendaSince). */
  readonly since: number;
  readonly zone: TimeZone;
  /** Whether any team of the tree has `pushGuard.pushToProtected` `gated`; off it, the digest shows only while its window holds a row. */
  readonly gated: boolean;
}

const isSelfMerge = (record: MergeRecord): record is SelfMerge => record.route === 'self';

function rowOf(merge: SelfMerge, zone: TimeZone, team: string | undefined): string {
  const range = `${merge.base.slice(0, 8)}..${merge.head.slice(0, 8)}`;
  const checks = merge.checks.length === 0 ? 'no checks' : `checks ${merge.checks.join(', ')}`;
  const mark = merge.review === 'checked' ? ', CHECK-CLEAN' : '';
  const session = team === undefined ? merge.session : formatAddress({ team, id: merge.session });
  return `  ${zone.weekdayMinute(new Date(merge.at))} ${session} ${merge.repo} ${merge.branch} ${range}: ${merge.files} files, ${merge.lines} lines, ${checks}${mark}`;
}

/** A log's self-merges since the digest's start, check-clean ones first, each group oldest first. */
function selfMergesOf({ log }: MergeLogAt, since: number): { readonly merged: readonly SelfMerge[]; readonly checked: number } {
  const merged = log.records.filter(isSelfMerge).filter((merge) => Date.parse(merge.at) >= since);
  const checked = merged.filter((merge) => merge.review === 'checked');
  return { merged: [...checked, ...merged.filter((merge) => merge.review !== 'checked')], checked: checked.length };
}

/**
 * MERGES: the self-merges since the agenda's start, the lead's team's first, then each team's under it by
 * `<team>/<session>`, a team past TEAM_ROWS as one count line naming its log.
 */
export function mergeDigestLines(input: MergeDigestInput): string[] {
  const { since, zone } = input;
  const own = selfMergesOf(input.own, since);
  const below = input.below.map((entry) => ({ entry, ...selfMergesOf(entry, since) }));
  const total = below.reduce((sum, team) => sum + team.merged.length, own.merged.length);
  if (!input.gated && total === 0) {
    return [];
  }
  const checked = below.reduce((sum, team) => sum + team.checked, own.checked);
  const skipped = [input.own, ...input.below]
    .filter(({ log }) => log.skipped > 0)
    .map(({ log, path }) => `; ${log.skipped} unreadable line(s) skipped in ${path}`)
    .join('');
  return [
    ...listed(
      `MERGES ${total} merged with no approval since ${zone.weekdayMinute(new Date(since))}, ${checked} CHECK-CLEAN (security samples those weekly)${skipped}`,
      own.merged.map((merge) => rowOf(merge, zone, undefined)),
      input.own.path,
    ),
    ...below.flatMap(({ entry, merged, checked: teamChecked }) =>
      teamPart(
        merged.map((merge) => rowOf(merge, zone, entry.team)),
        `  ${entry.team}: ${merged.length} merged with no approval, ${teamChecked} CHECK-CLEAN: ${entry.path}`,
      ),
    ),
  ];
}
