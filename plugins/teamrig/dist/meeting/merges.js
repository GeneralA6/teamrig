import { listed } from "./agenda.js";
const isSelfMerge = (record) => record.route === 'self';
function rowOf(merge, zone) {
    const range = `${merge.base.slice(0, 8)}..${merge.head.slice(0, 8)}`;
    const checks = merge.checks.length === 0 ? 'no checks' : `checks ${merge.checks.join(', ')}`;
    const mark = merge.review === 'checked' ? ', CHECK-CLEAN' : '';
    return `  ${zone.weekdayMinute(new Date(merge.at))} ${merge.session} ${merge.repo} ${merge.branch} ${range}: ${merge.files} files, ${merge.lines} lines, ${checks}${mark}`;
}
/** MERGES: the self-merges since the agenda's start, check-clean ones first and marked, each group oldest first. */
export function mergeDigestLines(input) {
    const { log, since, zone } = input;
    const merged = log.records.filter(isSelfMerge).filter((merge) => Date.parse(merge.at) >= since);
    if (!input.gated && merged.length === 0) {
        return [];
    }
    const checked = merged.filter((merge) => merge.review === 'checked');
    const rest = merged.filter((merge) => merge.review !== 'checked');
    const skipped = log.skipped === 0 ? '' : `; ${log.skipped} unreadable line(s) skipped in ${input.path}`;
    return listed(`MERGES ${merged.length} merged with no approval since ${zone.weekdayMinute(new Date(since))}, ${checked.length} CHECK-CLEAN (security samples those weekly)${skipped}`, [...checked, ...rest].map((merge) => rowOf(merge, zone)), input.path);
}
