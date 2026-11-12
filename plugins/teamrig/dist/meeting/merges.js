import { formatAddress } from "../core/address.js";
import { listed, teamPart } from "./agenda.js";
const isSelfMerge = (record) => record.route === 'self';
function rowOf(merge, zone, team) {
    const range = `${merge.base.slice(0, 8)}..${merge.head.slice(0, 8)}`;
    const checks = merge.checks.length === 0 ? 'no checks' : `checks ${merge.checks.join(', ')}`;
    const mark = merge.review === 'checked' ? ', CHECK-CLEAN' : '';
    const session = team === undefined ? merge.session : formatAddress({ team, id: merge.session });
    return `  ${zone.weekdayMinute(new Date(merge.at))} ${session} ${merge.repo} ${merge.branch} ${range}: ${merge.files} files, ${merge.lines} lines, ${checks}${mark}`;
}
/** A log's self-merges since the digest's start, check-clean ones first, each group oldest first. */
function selfMergesOf({ log }, since) {
    const merged = log.records.filter(isSelfMerge).filter((merge) => Date.parse(merge.at) >= since);
    const checked = merged.filter((merge) => merge.review === 'checked');
    return { merged: [...checked, ...merged.filter((merge) => merge.review !== 'checked')], checked: checked.length };
}
/**
 * MERGES: the self-merges since the agenda's start, the lead's team's first, then each team's under it by
 * `<team>/<session>`, a team past TEAM_ROWS as one count line naming its log.
 */
export function mergeDigestLines(input) {
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
        ...listed(`MERGES ${total} merged with no approval since ${zone.weekdayMinute(new Date(since))}, ${checked} CHECK-CLEAN (security samples those weekly)${skipped}`, own.merged.map((merge) => rowOf(merge, zone, undefined)), input.own.path),
        ...below.flatMap(({ entry, merged, checked: teamChecked }) => teamPart(merged.map((merge) => rowOf(merge, zone, entry.team)), `  ${entry.team}: ${merged.length} merged with no approval, ${teamChecked} CHECK-CLEAN: ${entry.path}`)),
    ];
}
