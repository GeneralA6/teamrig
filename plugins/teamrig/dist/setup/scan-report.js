import { formatCount } from "../budget/format.js";
import { clipEnd } from "../core/clip.js";
import { KIT_NAME } from "../core/home.js";
import { homeRelative } from "../core/paths.js";
import { PLACE_KINDS } from "../rules/places.js";
import { loadsUnasked, rankCandidates } from "../rules/rank.js";
import { topicsLabel } from "../rules/topics.js";
import { MEMORY_INDEX_LINES } from "./scan-context.js";
import { tokensOf } from "./scan-finding.js";
import { unusedSection } from "./scan-unused.js";
/**
 * The lines `teamrig setup scan` prints: the setup backup a slimming can be undone from (or NO BACKUP, which stops
 * one), every file and listing a session loads with its size, then the findings, one
 * line each, `<id> <kind> <path>: <what> (~<tokens> tokens/turn)`, numbered per section (C, D, O, S, U), and what
 * applying the CONTEXT, DUPLICATE and UNUSED ones saves. A rule line prints as a redacted excerpt of at most
 * EXCERPT_MAX_CHARS; settings values never print. OVERRIDE counts its lines by kind and prints only the first
 * OVERRIDE_TOP in the order to judge them (`rankCandidates`), since a setup holds hundreds of them: that order is where
 * to start, while `rules scan` lists every line, a kind at a time, for the model to judge.
 * UNUSED judges by the transcripts read and Claude Code's own `/skill-doctor` count, which also covers plugins' skills.
 */
/** An always-loaded file longer than this is worth slimming. */
export const LARGE_FILE_CHARS = 6000;
/** A skill description longer than this is worth shortening. */
export const LONG_DESCRIPTION_CHARS = 250;
/** A repeated or overriding line prints up to this many characters. */
const EXCERPT_MAX_CHARS = 60;
/** How many override lines the scan prints, the first to judge; `rules scan` lists them all. */
const OVERRIDE_TOP = 10;
/** How long ago something was, at a glance: `under a minute`, `12 min`, `5 h`, `3 days`. */
function ageOf(ms) {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) {
        return 'under a minute';
    }
    const hours = Math.floor(minutes / 60);
    return minutes < 60 ? `${minutes} min` : hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}
/** The backup that undoes a slimming of the setup, or the line that stops one until a backup exists. */
function backupLine(backup, now) {
    if (backup === undefined) {
        return `NO BACKUP of this setup: change nothing in it before ${KIT_NAME} setup backup makes one`;
    }
    return `BACKUP ${backup.stamp}, made ${ageOf(now - backup.madeAt)} ago: ${KIT_NAME} setup restore ${backup.stamp} previews putting the setup back`;
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
const SKILL_NAMES = { kind: 'skills', entries: 'skill(s)', folders: 'skill folders', missed: "plugins' skills" };
const AGENT_NAMES = { kind: 'agents', entries: 'agent type(s)', folders: 'agent folders', missed: "built-in and plugins' agent types" };
function listingLine(names, listing) {
    const from = listing.sources === undefined
        ? `summed from the user's and the project's ${names.folders} (${names.missed} not counted: no transcript of this project yet)`
        : `as this project's newest transcript lists them: ${listing.sources.map((source) => `${source.name} ${source.count} (${formatCount(source.chars)} chars)`).join(', ')}`;
    return `CONTEXT ${names.kind} ${listing.count} ${names.entries} listed: ${sized(listing.chars)}; ${from}`;
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
/** Claude Code's in-session check of the instructions themselves: it runs a model, so the scan suggests it, never runs it. */
const PROMPT_AUDIT = "NEXT /doctor prompt-audit in a session of the project: Claude Code's model-run check for outdated or conflicting instructions";
/** `O1 claude-md ~/.claude/CLAUDE.md:4: "<excerpt>" (15 push; teamrig)`: the first override lines to judge. */
function topOverrides(scan, at, show) {
    return rankCandidates(scan.overrides)
        .slice(0, OVERRIDE_TOP)
        .map((candidate) => ({
        kind: candidate.place.kind,
        where: `${show(candidate.place.path)}:${candidate.line}`,
        what: `"${clipEnd(at.secrets.redact(candidate.text), EXCERPT_MAX_CHARS)}" (${topicsLabel(candidate.topics)})`,
        saves: 0,
    }));
}
function overrideLines(scan, at, show) {
    const recorded = `${scan.recorded} recorded`;
    if (scan.overrides.length === 0) {
        return [`OVERRIDE none to judge; ${recorded}`, PROMPT_AUDIT];
    }
    const files = new Set(scan.overrides.map((candidate) => candidate.place.path));
    const kinds = PLACE_KINDS.flatMap((kind) => {
        const count = scan.overrides.filter((candidate) => candidate.place.kind === kind).length;
        return count === 0 ? [] : [`${kind} ${count}`];
    });
    const unasked = scan.overrides.filter(loadsUnasked).length;
    const top = topOverrides(scan, at, show);
    return [
        `OVERRIDE ${scan.overrides.length} line(s) in ${files.size} file(s) may override a core rule: ${kinds.join(', ')}; ${recorded}; ${unasked} load unasked; the ${top.length} to judge first below`,
        ...findingLines('O', top),
        `NEXT ${KIT_NAME} rules scan${afterTeam(at)}, to judge each line with the user`,
        PROMPT_AUDIT,
    ];
}
function settingsLines(scan, at, show) {
    if (scan.settings.length === 0) {
        return ['SETTINGS none'];
    }
    const findings = scan.settings.map((finding) => ({
        kind: finding.kind,
        where: show(finding.path),
        what: finding.copies === 0 ? finding.what : `${finding.what}; the same in ${finding.copies} more file(s) under .claude/worktrees`,
        saves: 0,
    }));
    const trim = scan.settings.some((finding) => finding.kind === 'wide-allow') ? [`NEXT ${KIT_NAME} permissions trim${afterTeam(at)}`] : [];
    return [`SETTINGS ${findings.length} finding(s)`, ...findingLines('S', findings), ...trim];
}
export function scanReport(scan, at) {
    const show = (path) => homeRelative(path, at.userHome);
    const unused = unusedSection(scan, at, show);
    const context = contextFindings(scan, unused.skills, show);
    const duplicates = duplicateFindings(scan, at, show);
    const loaded = scan.context.files.reduce((sum, file) => sum + file.text.length, 0) + scan.listing.chars + scan.agentListing.chars;
    const savings = [...context, ...duplicates, ...unused.findings].reduce((sum, finding) => sum + finding.saves, 0);
    return [
        `SCAN ${show(at.project)} (${at.team === undefined ? 'no team yet' : `team ${at.team}`})`,
        backupLine(at.backup, at.now),
        ...scan.context.files.map((file) => fileLine(file, show)),
        listingLine(SKILL_NAMES, scan.listing),
        listingLine(AGENT_NAMES, scan.agentListing),
        `TOTAL ${sized(loaded)} at every session start`,
        ...findingLines('C', context),
        duplicates.length === 0 ? 'DUPLICATE none' : `DUPLICATE ${duplicates.length} line(s) or sentence(s) repeat one loaded before`,
        ...findingLines('D', duplicates),
        ...overrideLines(scan, at, show),
        ...settingsLines(scan, at, show),
        unused.header,
        ...findingLines('U', unused.findings),
        `SAVINGS ${perTurn(savings)} if every CONTEXT, DUPLICATE and UNUSED finding is applied`,
    ];
}
