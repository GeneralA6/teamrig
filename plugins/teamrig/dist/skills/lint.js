import { parseUtcDay } from "../core/time.js";
import { grantGaps } from "./grants.js";
import { signatureOf } from "./signature.js";
export const SKILL_FLAG_KINDS = ['OWNER', 'UNVERIFIED', 'VERIFIED-NOTE', 'FORBIDDEN-KEY', 'DESCRIPTION', 'SIGNATURE', 'GRANT', 'AREA-OVER-LIMIT'];
const DAY_MS = 86_400_000;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;
const TOP_LEVEL_KEY = /^([A-Za-z0-9_-]+)\s*:/gm;
/** The `Last verified:` date and the rest of its line. */
export const LAST_VERIFIED = /Last verified:\s*(\d{4}-\d{2}-\d{2})([^\n]*)/;
/** What may follow that date: the sentence's end and markdown emphasis, nothing a run would add. */
const DATE_END = /^[\s.*_]*$/;
/** A SKILL.md split into its frontmatter (without the `---` lines) and its body. */
export function splitFrontmatter(text) {
    const match = FRONTMATTER.exec(text);
    return match === null ? { front: '', body: text } : { front: match[1] ?? '', body: match[2] ?? '' };
}
function frontmatterKeys(front) {
    return new Set(Array.from(front.matchAll(TOP_LEVEL_KEY), (match) => match[1] ?? ''));
}
/** A top-level frontmatter key's text value, inline (quoted or not) or as a YAML block scalar (`>` / `|`); `key` is a plain word. */
export function frontmatterValue(front, key) {
    const lines = front.split(/\r?\n/);
    const named = new RegExp(`^${key}\\s*:\\s*`);
    const at = lines.findIndex((line) => named.test(line));
    if (at === -1) {
        return null;
    }
    const inline = (lines[at] ?? '').replace(named, '').trim();
    if (/^[>|][+-]?$/.test(inline)) {
        const block = [];
        for (const line of lines.slice(at + 1)) {
            if (!/^\s/.test(line)) {
                break;
            }
            block.push(line.trim());
        }
        const text = block.join(' ').trim();
        return text === '' ? null : text;
    }
    const text = inline.replace(/^(["'])(.*)\1$/, '$2').trim();
    return text === '' ? null : text;
}
/** The frontmatter `description` (`frontmatterValue`). */
export function descriptionOf(front) {
    return frontmatterValue(front, 'description');
}
/** A skill's area: the longest session id (or shared prefix) it starts with, else its first word. */
export function areaOf(name, areas) {
    const match = areas.filter((area) => name.startsWith(`${area}-`)).sort((a, b) => b.length - a.length)[0];
    return match ?? name.split('-')[0] ?? name;
}
/**
 * Lints every skill against the team's rules; the flags come in skill order, area flags last. `elsewhere` holds the
 * sessions of the other teams of the team's tree that read the same skills folder: a skill one of them owns, and no
 * session of the team, is linted by its owner's team's check, so it gets no flag here and counts in no area (T1473).
 */
export function lintSkills(skills, now, team, elsewhere) {
    const rules = team.skills;
    const sessions = new Set(team.sessions);
    const areas = [...team.sessions, rules.sharedPrefix];
    const flags = [];
    const perArea = new Map();
    for (const skill of skills) {
        const { front, body } = splitFrontmatter(skill.text);
        // A trailing . , or ; ends the sentence, not the name ("Owner: alpha.").
        const owner = /^Owner:\s*(\S+?)[.,;]?(?=\s|$)/m.exec(body)?.[1] ?? null;
        if (owner !== null && !sessions.has(owner) && elsewhere.has(owner)) {
            continue;
        }
        const flag = (kind, detail) => {
            flags.push({ kind, skill: skill.name, owner, detail });
        };
        if (owner === null) {
            flag('OWNER', 'no "Owner: <session>" line');
        }
        else if (!sessions.has(owner)) {
            flag('OWNER', `owner ${owner} is not a session on the team`);
        }
        const verifiedLine = LAST_VERIFIED.exec(body);
        const verified = verifiedLine?.[1];
        const verifiedAt = verified === undefined ? undefined : parseUtcDay(verified);
        if (verified === undefined || verifiedAt === undefined) {
            flag('UNVERIFIED', 'no "Last verified: YYYY-MM-DD"');
        }
        else {
            const age = Math.floor((now.getTime() - verifiedAt.getTime()) / DAY_MS);
            if (age > rules.maxVerifiedAgeDays) {
                flag('UNVERIFIED', `last verified ${verified}, ${age} d ago > ${rules.maxVerifiedAgeDays}`);
            }
        }
        // A note after the date turns the line into a log that every run rewrites at its end, so two sessions
        // verifying the skill at once edit the same text and one edit is refused; the date alone lets both bumps agree.
        if (verifiedLine !== null && !DATE_END.test(verifiedLine[2] ?? '')) {
            flag('VERIFIED-NOTE', 'text after the "Last verified:" date: keep the date alone, a lesson on its own line');
        }
        const keys = frontmatterKeys(front);
        for (const key of rules.forbidFrontmatter.filter((forbidden) => keys.has(forbidden))) {
            flag('FORBIDDEN-KEY', `${key} is not allowed in a team skill: remove it`);
        }
        const description = descriptionOf(front);
        const words = description === null ? 0 : description.split(/\s+/).filter((word) => word !== '').length;
        if (description === null) {
            flag('DESCRIPTION', 'no description');
        }
        else if (words > rules.maxDescriptionWords) {
            flag('DESCRIPTION', `${words} words > ${rules.maxDescriptionWords}`);
        }
        for (const source of signatureOf(skill).invalid) {
            flag('SIGNATURE', `"Signature: \`${source}\`" is not a valid regex, so the scorecard misses its uses`);
        }
        for (const gap of grantGaps(body, skill.scripts)) {
            flag('GRANT', gap);
        }
        const area = areaOf(skill.name, areas);
        perArea.set(area, (perArea.get(area) ?? 0) + 1);
    }
    for (const [area, count] of perArea) {
        if (count > rules.maxPerArea) {
            flags.push({
                kind: 'AREA-OVER-LIMIT',
                skill: area,
                owner: sessions.has(area) ? area : null,
                detail: `${count} skills > ${rules.maxPerArea}: merge before adding`,
            });
        }
    }
    return flags;
}
export function formatSkillFlag(flag) {
    return `SKILL ${flag.kind} (${flag.detail}) ${flag.owner ?? '-'} ${flag.skill}`;
}
