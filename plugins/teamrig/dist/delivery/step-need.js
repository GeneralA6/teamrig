/** A step's need is learned from at most this many of its latest ended runs. */
export const NEED_RUNS = 20;
/** The most a run's process tree held counts with this margin, as the tree's sampled peak can miss a short burst. */
export const PEAK_MARGIN = 1.25;
/** An ended run of a queued step that measured its tree's peak or what the host lost while it ran. */
function isMeasuredRun(record) {
    return record.type === 'heavy' && record.endedAt !== null && (record.peakTreeMb !== undefined || (record.startFreeMb !== undefined && record.lowFreeMb !== undefined));
}
/** The middle value of `values`, which are not empty, rounded up: the mean of the two middle ones for an even count. */
function medianOf(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const upper = sorted[middle] ?? 0;
    const lower = sorted.length % 2 === 0 ? (sorted[middle - 1] ?? upper) : upper;
    return Math.ceil((lower + upper) / 2);
}
/**
 * The MB `runs` show the step needs: the most its tree held, with PEAK_MARGIN, or the median of what the host lost
 * while it ran (start less least free memory), whichever is more. The host's loss catches memory the step makes others
 * take (a VM, a database's cache); its median keeps one run beside another app's spike from pinning the need high.
 */
function measuredMbOf(runs) {
    const peaks = runs.flatMap((run) => (run.peakTreeMb === undefined ? [] : [run.peakTreeMb]));
    const drops = runs.flatMap((run) => (run.startFreeMb === undefined || run.lowFreeMb === undefined ? [] : [Math.max(0, run.startFreeMb - run.lowFreeMb)]));
    const peakMb = peaks.length === 0 ? 0 : Math.ceil(Math.max(...peaks) * PEAK_MARGIN);
    return Math.max(peakMb, drops.length === 0 ? 0 : medianOf(drops));
}
/** The need the latest NEED_RUNS of `runs` show, when they show one over 0 MB. */
function learnedOf(runs, from) {
    const latest = runs.slice(-NEED_RUNS);
    const reserveMb = latest.length === 0 ? 0 : measuredMbOf(latest);
    return reserveMb > 0 ? { reserveMb, runs: latest.length, from } : undefined;
}
/**
 * The need a step's past runs show, from `records` in ledger order: its session's measured runs under the same label;
 * with none, its session's measured runs of the same kind and size (small or not). Kind `other` is never matched by
 * kind alone, as it spans ships, checks and installs, whose most would pin every such step high.
 */
export function learnedNeedOf(records, ask) {
    const runs = records.filter(isMeasuredRun).filter((run) => run.session === ask.session);
    const byLabel = learnedOf(runs.filter((run) => run.what === ask.what), 'label');
    if (byLabel !== undefined || ask.kind === 'other') {
        return byLabel;
    }
    return learnedOf(runs.filter((run) => run.kind === ask.kind && (run.shared === true) === ask.small), 'kind');
}
/** Where a learned need came from, as a wait line says it: `learned from 12 runs`, or `learned from 3 test runs` by kind. */
function learnedText(learned, kind) {
    const runs = learned.from === 'label' ? 'run' : `${kind} run`;
    return `learned from ${learned.runs} ${runs}${learned.runs === 1 ? '' : 's'}`;
}
/**
 * What a queued step asks of the host: a small one shares it, a heavy one takes the lock, each holding the more of its
 * learned need (`learnedNeedOf`) and its declared `--memory-mb` (declared on a tie), else the config's
 * `smallReserveMb`; a heavy step holds at least `heavyReserveMb`. The need's `basis` says where a learned or declared
 * MB came from; a default has none.
 */
export function stepNeedOf(records, ask, defaults) {
    const learned = learnedNeedOf(records, ask);
    const known = [
        ...(ask.declaredMb === undefined ? [] : [{ reserveMb: ask.declaredMb, basis: 'declared with --memory-mb' }]),
        ...(learned === undefined ? [] : [{ reserveMb: learned.reserveMb, basis: learnedText(learned, ask.kind) }]),
    ].reduce((most, need) => (most === undefined || need.reserveMb > most.reserveMb ? need : most), undefined);
    if (ask.small) {
        return known === undefined ? { shares: true, reserveMb: defaults.smallReserveMb } : { shares: true, ...known };
    }
    return known === undefined || known.reserveMb < defaults.heavyReserveMb ? { shares: false, reserveMb: defaults.heavyReserveMb } : { shares: false, ...known };
}
