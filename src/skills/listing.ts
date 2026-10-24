import type { OtherAreaListing } from '../config/types.ts';
import { areaOf, splitFrontmatter, type SkillText } from './lint.ts';

/** The sessions a skill's `Used by: <session>, <session>` body line names; none without the line. */
export function usedByOf(text: string): string[] {
  const line = /^Used by:(.*)$/m.exec(splitFrontmatter(text).body)?.[1] ?? '';
  // A trailing . or ; ends the sentence, not the last name ("Used by: alpha, bravo.").
  return line
    .split(/[\s,]+/)
    .map((word) => word.replace(/[.;]$/, ''))
    .filter((word) => word !== '');
}

/** Whose skill listing it is, the areas a skill may belong to, and how the skills of other areas are listed. */
export interface ListingScope {
  readonly session: string;
  /** The session ids of every team sharing the skills folder: a skill of none of their areas is a personal one. */
  readonly areas: readonly string[];
  readonly sharedPrefix: string;
  readonly otherAreas: OtherAreaListing;
}

/**
 * Claude Code's `skillOverrides` for one session: each skill of another session's area whose `Used by:` line does not
 * name the session, at `otherAreas`. The session's own skills, the shared ones and personal ones stay listed in full,
 * and `on` lists every skill in full.
 */
export function listingOverrides(skills: readonly SkillText[], scope: ListingScope): Record<string, OtherAreaListing> {
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
