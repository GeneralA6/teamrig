import { descriptionOf, LAST_VERIFIED, splitFrontmatter } from "./lint.js";
import { EMPTY_SKILL_DAY, LOAD_WINDOW_CALLS } from "./scorecard.js";
/** One row per installed skill, and per skill counted in the window that is no longer installed, sorted by name. */
export function scorecardRows(sources, window, baseline) {
    const now = sumDays(sources.days, window);
    const before = sumDays(sources.days, baseline);
    const installed = new Map(sources.skills.map((skill, index) => [skill.name, { file: skill, signature: sources.signatures[index] }]));
    const names = [...new Set([...installed.keys(), ...now.keys()])].sort();
    return names.map((name) => {
        const day = now.get(name) ?? EMPTY_SKILL_DAY;
        const base = before.get(name) ?? EMPTY_SKILL_DAY;
        const skill = installed.get(name);
        const flags = [];
        if (skill === undefined) {
            flags.push('no SKILL.md');
        }
        else {
            if (day.loads === 0) {
                flags.push('not loaded');
            }
            if (skill.signature === undefined || (skill.signature.patterns.length === 0 && skill.signature.invalid.length === 0)) {
                flags.push('no signature');
            }
            flags.push(...new Set(sources.lint.filter((flag) => flag.skill === name).map((flag) => flag.kind)));
        }
        const text = skill === undefined ? undefined : splitFrontmatter(skill.file.text);
        const description = text === undefined ? null : descriptionOf(text.front);
        return {
            skill: name,
            loads: day.loads,
            missed: day.manual.runs,
            callsPerRun: perRun(day.skill, day.skill.calls),
            baseCallsPerRun: perRun(base.manual, base.manual.calls),
            errorsPerRun: perRun(day.skill, day.skill.failed + day.skill.refused),
            baseErrorsPerRun: perRun(base.manual, base.manual.failed + base.manual.refused),
            refused: day.skill.refused + day.manual.refused,
            edits: day.edits,
            lastVerified: text === undefined ? undefined : LAST_VERIFIED.exec(text.body)?.[1],
            descriptionWords: description === null ? undefined : description.split(/\s+/).filter((word) => word !== '').length,
            flags,
        };
    });
}
function perRun(tally, count) {
    return tally.runs === 0 ? undefined : count / tally.runs;
}
function addTally(a, b) {
    return { runs: a.runs + b.runs, calls: a.calls + b.calls, failed: a.failed + b.failed, refused: a.refused + b.refused };
}
function sumDays(days, range) {
    const sums = new Map();
    for (const [day, skills] of Object.entries(days)) {
        if (day < range.from || day > range.to) {
            continue;
        }
        for (const [name, counts] of Object.entries(skills)) {
            const sum = sums.get(name) ?? EMPTY_SKILL_DAY;
            sums.set(name, {
                loads: sum.loads + counts.loads,
                skill: addTally(sum.skill, counts.skill),
                manual: addTally(sum.manual, counts.manual),
                edits: sum.edits + counts.edits,
            });
        }
    }
    return sums;
}
const HEADER = ['skill', 'loads', 'missed', 'calls/run', 'base calls/run', 'err/run', 'base err/run', 'refused', 'edits', 'last verified', 'desc words', 'flags'];
function ratio(value) {
    return value === undefined ? '-' : value.toFixed(1);
}
/** The scorecard as a markdown table, with what it measured and what it could not. */
export function renderScorecard(rows, footer) {
    const cells = (values) => `| ${values.join(' | ')} |`;
    const lines = [
        `Skills scorecard ${footer.window.from} to ${footer.window.to}, baseline ${footer.baseline.from} to ${footer.baseline.to}`,
        '',
        cells(HEADER),
        cells(HEADER.map(() => '---')),
        ...rows.map((row) => cells([
            row.skill,
            String(row.loads),
            String(row.missed),
            ratio(row.callsPerRun),
            ratio(row.baseCallsPerRun),
            ratio(row.errorsPerRun),
            ratio(row.baseErrorsPerRun),
            String(row.refused),
            String(row.edits),
            row.lastVerified ?? '-',
            row.descriptionWords === undefined ? '-' : String(row.descriptionWords),
            row.flags.join(', '),
        ])),
        '',
        `missed: a call matching the skill's Signature line with no load in the ${LOAD_WINDOW_CALLS} calls before. A run ends at the next prompt, or for a background step of its own at the notification after it; base = the procedure by hand in the baseline.`,
        `Read ${footer.files} files, ${(footer.bytesRead / (1024 * 1024)).toFixed(1)} MB this run.`,
    ];
    if (footer.catchingUp) {
        lines.push('Catching up: transcripts are still partly unread; run again for complete counts.');
    }
    const earliest = footer.baseline.from < footer.window.from ? footer.baseline.from : footer.window.from;
    if (earliest < footer.since) {
        lines.push(`Days before ${footer.since} are not counted: the scorecard's first read started there.`);
    }
    return lines;
}
