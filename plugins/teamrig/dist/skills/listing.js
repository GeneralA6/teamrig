import { areaOf, splitFrontmatter } from "./lint.js";
/** The sessions a skill's `Used by: <session>, <session>` body line names; none without the line. */
export function usedByOf(text) {
    const line = /^Used by:(.*)$/m.exec(splitFrontmatter(text).body)?.[1] ?? '';
    // A trailing . or ; ends the sentence, not the last name ("Used by: alpha, bravo.").
    return line
        .split(/[\s,]+/)
        .map((word) => word.replace(/[.;]$/, ''))
        .filter((word) => word !== '');
}
/**
 * Claude Code's `skillOverrides` for one session: each skill of another session's area whose `Used by:` line does not
 * name the session, at `otherAreas`. The session's own skills, the shared ones and personal ones stay listed in full,
 * and `on` lists every skill in full.
 */
export function listingOverrides(skills, scope) {
    if (scope.otherAreas === 'on') {
        return {};
    }
    const sessions = new Set(scope.areas);
    const prefixes = [...scope.areas, scope.sharedPrefix];
    const listed = skills.filter((skill) => {
        const area = areaOf(skill.name, prefixes);
        return area !== scope.session && area !== scope.sharedPrefix && sessions.has(area) && !usedByOf(skill.text).includes(scope.session);
    });
    return Object.fromEntries(listed.map((skill) => [skill.name, scope.otherAreas]));
}
