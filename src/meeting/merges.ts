import type { TimeZone } from '../core/zone.ts';
import type { MergeLogRead, MergeRecord, SelfMerge } from '../merge/merge-log.ts';
import { listed } from './agenda.ts';

/**
 * The meeting's digest of self-merges (T800 §2.2, T858): what `teamrig integrate` landed with no approval since the
 * meeting before, read from the team's merges log. A self-merge only the review check looked at (`review: checked`)
 * is marked CHECK-CLEAN, as security samples those weekly; those list first, so the row cap never hides one. A change
 * a leader approved is left out: a leader saw it already.
 */

export interface MergeDigestInput {
  readonly log: MergeLogRead;
  /** When the digest starts: the agenda's start (agendaSince). */
  readonly since: number;
  readonly zone: TimeZone;
  /** Whether `pushGuard.pushToProtected` is `gated`; a team off it gets the digest only while its window holds a row. */
  readonly gated: boolean;
  /** The merges log's path, which the `+N more` line names. */
  readonly path: string;
}

const isSelfMerge = (record: MergeRecord): record is SelfMerge => record.route === 'self';

function rowOf(merge: SelfMerge, zone: TimeZone): string {
  const range = `${merge.base.slice(0, 8)}..${merge.head.slice(0, 8)}`;
  const checks = merge.checks.length === 0 ? 'no checks' : `checks ${merge.checks.join(', ')}`;
  const mark = merge.review === 'checked' ? ', CHECK-CLEAN' : '';
  return `  ${zone.weekdayMinute(new Date(merge.at))} ${merge.session} ${merge.repo} ${merge.branch} ${range}: ${merge.files} files, ${merge.lines} lines, ${checks}${mark}`;
}

/** MERGES: the self-merges since the agenda's start, check-clean ones first and marked, each group oldest first. */
export function mergeDigestLines(input: MergeDigestInput): string[] {
  const { log, since, zone } = input;
  const landed = log.records.filter(isSelfMerge).filter((merge) => Date.parse(merge.at) >= since);
  if (!input.gated && landed.length === 0) {
    return [];
  }
  const checked = landed.filter((merge) => merge.review === 'checked');
  const rest = landed.filter((merge) => merge.review !== 'checked');
  const skipped = log.skipped === 0 ? '' : `; ${log.skipped} unreadable line(s) skipped in ${input.path}`;
  return listed(
    `MERGES ${landed.length} landed with no approval since ${zone.weekdayMinute(new Date(since))}, ${checked.length} CHECK-CLEAN (security samples those weekly)${skipped}`,
    [...checked, ...rest].map((merge) => rowOf(merge, zone)),
    input.path,
  );
}
