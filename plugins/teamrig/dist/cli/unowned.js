import { clipEnd } from "../core/clip.js";
import { KIT_NAME } from "../core/home.js";
import { formatFinding } from "../doctor/doctor.js";
import { formatSkillFlag } from "../skills/lint.js";
/**
 * Warnings no session owns (T951). A context finding weighs text every session on the machine re-reads, so it is no
 * one area's; a skill flag goes to its skill's `Owner:`, which may be missing or name no session on the team. Such a
 * warning goes to the team's lead, with the check it came from, so it never reaches no one: the lead fixes it, hands
 * it on or settles the check.
 */
/** The most of a warning's text its inbox line carries; `check --all` prints it in full. */
export const UNOWNED_NOTICE_CHARS = 300;
function contextWarning(finding) {
    return { key: `context ${finding.budget}`, source: `the context check [contextFiles.${finding.budget}]`, text: formatFinding(finding) };
}
function skillWarning(flag, skillsDir) {
    return { key: `skill ${flag.kind} ${flag.skill}`, source: `the skill check of ${skillsDir}`, text: formatSkillFlag(flag) };
}
/**
 * Every context finding is unowned; a skill flag is owned when its owner is a session on the team, else it leaves
 * the skill flags for the unowned ones.
 */
export function splitUnowned(context, skills, sessions, skillsDir) {
    const owned = (flag) => flag.owner !== null && sessions.has(flag.owner);
    return {
        skills: skills.filter(owned),
        unowned: [...context.map(contextWarning), ...skills.filter((flag) => !owned(flag)).map((flag) => skillWarning(flag, skillsDir))],
    };
}
/** `UNOWNED 2 warning(s) no session owns, so they go to the lead (lead): ...`, the heading `check` prints over them. */
export function unownedHeading(count, lead) {
    return `UNOWNED ${count} warning(s) no session owns, so they go to the lead (${lead}): fix each, hand it on (${KIT_NAME} add --owner <session>) or settle its check`;
}
/** `from the context check [contextFiles.maxClaudeMdChars]: WARN context-size ...`. */
export function unownedRow(warning) {
    return `from ${warning.source}: ${warning.text}`;
}
/** The lead's one inbox line on a warning: where it came from, its text cut to UNOWNED_NOTICE_CHARS, and what to do. */
export function unownedNotice(warning) {
    const text = clipEnd(warning.text.replace(/\s+/g, ' ').trim(), UNOWNED_NOTICE_CHARS);
    return (`${warning.source} raised a warning no session owns, so it is yours as lead: ${text}; ` +
        `fix it, hand it on (${KIT_NAME} add --owner <session>) or settle the check (${KIT_NAME} check --all prints it in full)`);
}
