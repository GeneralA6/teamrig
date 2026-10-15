import { formatCount } from "../budget/format.js";
/** The longest command text the first line names; a longer one is cut with `…`. */
export const LABEL_CHARS = 60;
/** How many of the output's last lines a failed run with no failing tests to show prints. */
export const TAIL_LINES = 40;
/** The words after `--` as one label: joined by spaces and cut to `LABEL_CHARS` characters with `…`. */
export function labelOf(words) {
    const characters = [...words.join(' ')];
    return characters.length <= LABEL_CHARS ? characters.join('') : `${characters.slice(0, LABEL_CHARS - 1).join('')}…`;
}
/** A duration a person reads at a glance: `2.5 s`, `41 s`, `6 min 12 s`. */
export function formatDuration(ms) {
    if (ms < 9_950) {
        return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
    }
    const seconds = Math.round(ms / 1000);
    return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
function tests(count) {
    return `${formatCount(count)} ${count === 1 ? 'test' : 'tests'}`;
}
function failures(count) {
    return `${count} more ${count === 1 ? 'failure' : 'failures'} in the log`;
}
function passed(end) {
    return end.kind === 'exited' && end.code === 0;
}
/** How a failed command ended, as words after "the command": `exited 2`, `was ended by SIGTERM`. */
function endedAs(end) {
    return end.kind === 'exited' ? `exited ${end.code}` : `was ended by ${end.signal}`;
}
/** The first line: PASS or FAIL by the exit code, with the counts when the runner printed them. */
export function headline(run) {
    const { counts } = run.parsed;
    const took = formatDuration(run.tookMs);
    const log = `Log: ${run.log}`;
    if (passed(run.end)) {
        if (counts === null) {
            return `PASS ${run.label} in ${took}. ${log}`;
        }
        return counts.failed === 0
            ? `PASS ${run.label}: ${tests(counts.total)} in ${took}. ${log}`
            : `PASS ${run.label}: the command exited 0, but ${formatCount(counts.failed)} of ${tests(counts.total)} failed, in ${took}. ${log}`;
    }
    if (counts === null) {
        const how = run.end.kind === 'exited' ? `exit ${run.end.code}` : `ended by ${run.end.signal}`;
        return `FAIL ${run.label} in ${took} (${how}). ${log}`;
    }
    return counts.failed > 0
        ? `FAIL ${run.label}: ${formatCount(counts.failed)} of ${formatCount(counts.total)} failed in ${took}. ${log}`
        : `FAIL ${run.label}: 0 of ${tests(counts.total)} failed but the command ${endedAs(run.end)}, in ${took}. ${log}`;
}
/** Lines of `text` from its start that fit in `maxChars`, ending with `…` when lines were left out. */
function startOf(text, maxChars) {
    const kept = [];
    let used = 0;
    for (const line of text.split('\n')) {
        used += line.length + (kept.length > 0 ? 1 : 0);
        if (used > maxChars) {
            break;
        }
        kept.push(line);
    }
    return kept.length === 0 ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : `${kept.join('\n')}\n…`;
}
/**
 * The failing tests to print: whole ones while they fit in `maxChars` together (the first is cut at a
 * line when it alone is longer), then how many more the log holds. `total` is how many failed, when
 * the runner counted more than it printed.
 */
export function failureBlocks(blocks, total, maxChars) {
    const shown = [];
    let used = 0;
    for (const block of blocks) {
        used += block.length + (shown.length > 0 ? 2 : 0);
        if (used > maxChars) {
            break;
        }
        shown.push(block);
    }
    const [first] = blocks;
    if (shown.length === 0 && first !== undefined) {
        shown.push(startOf(first, maxChars));
    }
    const more = Math.max(total, blocks.length) - shown.length;
    return more > 0 ? [...shown, failures(more)] : shown;
}
/** The output's last `TAIL_LINES` lines, fewer when they pass `maxChars`, under a line saying how many. */
export function outputTail(output, maxChars) {
    const lines = output.replace(/\n+$/, '').split('\n').slice(-TAIL_LINES);
    if (lines.length === 1 && lines[0] === '') {
        return ['The command printed nothing.'];
    }
    let used = lines.reduce((sum, line) => sum + line.length + 1, -1);
    while (lines.length > 1 && used > maxChars) {
        used -= (lines.shift()?.length ?? 0) + 1;
    }
    const [only = ''] = lines;
    if (lines.length === 1 && only.length > maxChars) {
        lines[0] = `…${only.slice(only.length - Math.max(0, maxChars - 1))}`;
    }
    return [`The output's last ${lines.length === 1 ? 'line' : `${lines.length} lines`}:`, lines.join('\n')];
}
/**
 * What `teamrig test` prints: the headline, then for a failed run each failing test in full within
 * `maxFailureChars`, or the output's end when no runner's failures could be read. A passed run whose
 * output still shows failing tests prints them too.
 */
export function reportLines(run) {
    const head = headline(run);
    const { counts, failures: blocks } = run.parsed;
    if (blocks.length > 0) {
        return [head, ...failureBlocks(blocks, counts?.failed ?? 0, run.maxFailureChars).flatMap((block, index) => (index === 0 ? [block] : ['', block]))];
    }
    return passed(run.end) ? [head] : [head, ...outputTail(run.output, run.maxFailureChars)];
}
