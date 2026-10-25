import { formatCount } from "../budget/format.js";
import { clipEnd } from "../core/clip.js";
import { KIT_NAME } from "../core/home.js";
import { homeRelative } from "../core/paths.js";
import { PLACE_KINDS } from "../rules/places.js";
import { MEMORY_INDEX_LINES } from "./scan-context.js";
/**
 * The lines `teamrig setup scan` prints: every file and listing a session loads with its size, then the findings, one
 * line each, `<id> <kind> <path>: <what> (~<tokens> tokens/turn)`, numbered per section (C, D, S, U), and what
 * applying the CONTEXT, DUPLICATE and UNUSED ones saves. Rule lines and settings values are counted, never printed;
 * override lines only by kind, since a setup holds hundreds of them and `rules scan` lists them a kind at a time.
 */
/** An always-loaded file longer than this is worth slimming. */
export const LARGE_FILE_CHARS = 6000;
/** A skill description longer than this is worth shortening. */
export const LONG_DESCRIPTION_CHARS = 250;
/** Claude Code's rough rate: a token is about four characters of English. */
const CHARS_PER_TOKEN = 4;
/** A repeated line prints up to this many characters. */
const EXCERPT_MAX_CHARS = 60;
const BYTES_PER_MB = 1024 * 1024;
export function tokensOf(chars) {
    return Math.ceil(chars / CHARS_PER_TOKEN);
}
function perTurn(tokens) {
    return `~${formatCount(tokens)} tokens/turn`;
}
function sized(chars) {
    return `${formatCount(chars)} chars (${perTurn(tokensOf(chars))})`;
}
/** `C1 large-file <path>: <what> (~<n> tokens/turn)`; no token count on a finding that saves none. */
function findingLines(prefix, findings) {
    return findings.map(({ kind, where, what, saves }, index) => `${prefix}${index + 1} ${kind} ${where}: ${what}${saves === 0 ? '' : ` (${perTurn(saves)})`}`);
}
/** ` after `teamrig team create``: a NEXT step that needs a team, before one exists. */
function afterTeam(at) {
    return at.team === undefined ? `, after ${KIT_NAME} team create` : '';
}
function fileLine(file, show) {
    const memory = file.kind === 'memory' ? `, the first ${MEMORY_INDEX_LINES} lines Claude Code loads` : '';
    return `CONTEXT ${file.kind} ${show(file.path)}: ${sized(file.text.length)}${memory}`;
}
function listingLine(listing) {
    const from = listing.sources === undefined
        ? "summed from the user's and the project's skill folders (plugins' skills not counted: no transcript of this project yet)"
        : `as this project's newest transcript lists them: ${listing.sources.map((source) => `${source.name} ${source.count} (${formatCount(source.chars)} chars)`).join(', ')}`;
    return `CONTEXT skills ${listing.count} skill(s) listed: ${sized(listing.chars)}; ${from}`;
}
function contextFindings(scan, unused, show) {
    const large = scan.context.files
        .filter((file) => file.text.length > LARGE_FILE_CHARS)
        .map((file) => ({
        kind: 'large-file',
        where: show(file.path),
        what: `${formatCount(file.text.length)} chars, over the ${formatCount(LARGE_FILE_CHARS)} an always-loaded file should keep to`,
        saves: tokensOf(file.text.length - LARGE_FILE_CHARS),
    }));
    const long = scan.context.skills
        .filter((skill) => !unused.has(skill) && skill.description.length > LONG_DESCRIPTION_CHARS)
        .map((skill) => ({
        kind: 'long-description',
        where: show(skill.path),
        what: `skill ${skill.name}'s description is ${formatCount(skill.description.length)} chars, over ${LONG_DESCRIPTION_CHARS}`,
        saves: tokensOf(skill.description.length - LONG_DESCRIPTION_CHARS),
    }));
    return [...large, ...long];
}
function duplicateFindings(scan, at, show) {
    return scan.duplicates.map((duplicate) => ({
        kind: 'duplicate',
        where: `${show(duplicate.path)}:${duplicate.line}`,
        what: `"${clipEnd(at.secrets.redact(duplicate.text), EXCERPT_MAX_CHARS)}" repeats ${show(duplicate.firstPath)}:${duplicate.firstLine}`,
        saves: tokensOf(duplicate.text.length),
    }));
}
function overrideLines(scan, at) {
    const recorded = `${scan.recorded} recorded`;
    if (scan.overrides.length === 0) {
        return [`OVERRIDE none to judge; ${recorded}`];
    }
    const files = new Set(scan.overrides.map((candidate) => candidate.place.path));
    const kinds = PLACE_KINDS.flatMap((kind) => {
        const count = scan.overrides.filter((candidate) => candidate.place.kind === kind).length;
        return count === 0 ? [] : [`${kind} ${count}`];
    });
    return [
        `OVERRIDE ${scan.overrides.length} line(s) in ${files.size} file(s) may override a core rule: ${kinds.join(', ')}; ${recorded}`,
        `NEXT ${KIT_NAME} rules scan${afterTeam(at)}, to judge each line with the user`,
    ];
}
function settingsLines(scan, at, show) {
    if (scan.settings.length === 0) {
        return ['SETTINGS none'];
    }
    const findings = scan.settings.map((finding) => ({ kind: finding.kind, where: show(finding.path), what: finding.what, saves: 0 }));
    const trim = scan.settings.some((finding) => finding.kind === 'wide-allow') ? [`NEXT ${KIT_NAME} permissions trim${afterTeam(at)}`] : [];
    return [`SETTINGS ${findings.length} finding(s)`, ...findingLines('S', findings), ...trim];
}
function unusedFindings(unused, at, show) {
    return unused.map((skill) => ({
        kind: 'unused-skill',
        where: show(skill.path),
        what: `no Skill call or /${skill.name} in ${at.days} day(s)`,
        saves: tokensOf(skill.line.length),
    }));
}
function unusedHeader(scan, unused, at) {
    const { transcripts, bytes } = scan.usage;
    const young = notUsed(scan).filter((skill) => scan.recent.has(skill.path)).length;
    const unjudged = young === 0 ? '' : `; ${young} more changed in that time, too new to judge`;
    return `UNUSED ${unused.length} of ${scan.context.skills.length} skill(s) not used in ${at.days} day(s) (read ${transcripts} transcript(s), ${(bytes / BYTES_PER_MB).toFixed(1)} MB)${unjudged}`;
}
function notUsed(scan) {
    return scan.context.skills.filter((skill) => !scan.usage.used.has(skill.name));
}
/**
 * The skills no transcript used, of those whose file is older than the window: a skill written or changed inside it
 * has not had the whole window to be used. None when there is no transcript to tell, since then every skill would
 * look unused.
 */
function unusedSkills(scan) {
    return scan.usage.transcripts === 0 ? [] : notUsed(scan).filter((skill) => !scan.recent.has(skill.path));
}
export function scanReport(scan, at) {
    const show = (path) => homeRelative(path, at.userHome);
    const unused = unusedSkills(scan);
    const context = contextFindings(scan, new Set(unused), show);
    const duplicates = duplicateFindings(scan, at, show);
    const parked = unusedFindings(unused, at, show);
    const loaded = scan.context.files.reduce((sum, file) => sum + file.text.length, 0) + scan.listing.chars;
    const savings = [...context, ...duplicates, ...parked].reduce((sum, finding) => sum + finding.saves, 0);
    return [
        `SCAN ${show(at.project)} (${at.team === undefined ? 'no team yet' : `team ${at.team}`})`,
        ...scan.context.files.map((file) => fileLine(file, show)),
        listingLine(scan.listing),
        `TOTAL ${sized(loaded)} at every session start`,
        ...findingLines('C', context),
        duplicates.length === 0 ? 'DUPLICATE none' : `DUPLICATE ${duplicates.length} line(s) or sentence(s) repeat one loaded before`,
        ...findingLines('D', duplicates),
        ...overrideLines(scan, at),
        ...settingsLines(scan, at, show),
        scan.usage.transcripts === 0 ? `UNUSED not checked: no transcript on this machine in ${at.days} day(s)` : unusedHeader(scan, unused, at),
        ...findingLines('U', parked),
        `SAVINGS ${perTurn(savings)} if every CONTEXT, DUPLICATE and UNUSED finding is applied`,
    ];
}
