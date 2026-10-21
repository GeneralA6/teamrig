import { clipEnd } from '../core/clip.ts';
import { KIT_NAME } from '../core/home.ts';
import { formatFinding, type ContextFinding } from '../doctor/doctor.ts';
import { formatSkillFlag, type SkillFlag } from '../skills/lint.ts';

/**
 * Warnings no session owns (T951). A context finding weighs text every session on the machine re-reads, so it is no
 * one area's; a skill flag goes to its skill's `Owner:`, which may be missing or name no session on the team. Such a
 * warning goes to the team's lead, with the check it came from, so it never reaches no one: the lead fixes it, hands
 * it on or settles the check.
 */

/** The most of a warning's text its inbox line carries; `check --all` prints it in full. */
export const UNOWNED_NOTICE_CHARS = 300;

/** A warning no session owns. */
export interface UnownedWarning {
  /** Names the warning while it stands, whatever its detail says today, so the lead is told of it once. */
  readonly key: string;
  /** The check that raised it, with the config key or folder it reads. */
  readonly source: string;
  /** Its flag line, as `check --all` prints it. */
  readonly text: string;
}

/** The skill flags a session on the team owns, and every warning no session does. */
export interface SplitWarnings {
  readonly skills: readonly SkillFlag[];
  readonly unowned: readonly UnownedWarning[];
}

function contextWarning(finding: ContextFinding): UnownedWarning {
  return { key: `context ${finding.budget}`, source: `the context check [contextFiles.${finding.budget}]`, text: formatFinding(finding) };
}

function skillWarning(flag: SkillFlag, skillsDir: string): UnownedWarning {
  return { key: `skill ${flag.kind} ${flag.skill}`, source: `the skill check of ${skillsDir}`, text: formatSkillFlag(flag) };
}

/**
 * Every context finding is unowned; a skill flag is owned when its owner is a session on the team, else it leaves
 * the skill flags for the unowned ones.
 */
export function splitUnowned(context: readonly ContextFinding[], skills: readonly SkillFlag[], sessions: ReadonlySet<string>, skillsDir: string): SplitWarnings {
  const owned = (flag: SkillFlag): boolean => flag.owner !== null && sessions.has(flag.owner);
  return {
    skills: skills.filter(owned),
    unowned: [...context.map(contextWarning), ...skills.filter((flag) => !owned(flag)).map((flag) => skillWarning(flag, skillsDir))],
  };
}

/** `UNOWNED 2 warning(s) no session owns, so they go to the lead (lead): ...`, the heading `check` prints over them. */
export function unownedHeading(count: number, lead: string): string {
  return `UNOWNED ${count} warning(s) no session owns, so they go to the lead (${lead}): fix each, hand it on (${KIT_NAME} add --owner <session>) or settle its check`;
}

/** `from the context check [contextFiles.maxClaudeMdChars]: WARN context-size ...`. */
export function unownedRow(warning: UnownedWarning): string {
  return `from ${warning.source}: ${warning.text}`;
}

/** The lead's one inbox line on a warning: where it came from, its text cut to UNOWNED_NOTICE_CHARS, and what to do. */
export function unownedNotice(warning: UnownedWarning): string {
  const text = clipEnd(warning.text.replace(/\s+/g, ' ').trim(), UNOWNED_NOTICE_CHARS);
  return (
    `${warning.source} raised a warning no session owns, so it is yours as lead: ${text}; ` +
    `fix it, hand it on (${KIT_NAME} add --owner <session>) or settle the check (${KIT_NAME} check --all prints it in full)`
  );
}
