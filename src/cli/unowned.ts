import type { IdleMode } from '../config/types.ts';
import { clipEnd } from '../core/clip.ts';
import { KIT_NAME } from '../core/home.ts';
import { formatFinding, type AllowFinding, type ContextFinding, type DenyFinding } from '../doctor/doctor.ts';
import { formatSkillFlag, type SkillFlag } from '../skills/lint.ts';
import { formatIdlePassTrouble, type IdlePassTrouble } from './idle-pass-log.ts';

/**
 * Warnings no session owns (T951). A context finding weighs text every session on the machine re-reads, so it is no
 * one area's; a wide allow rule or a missing secret deny line sits in settings every session runs under, and a
 * permissions change is the owner's gate, which the lead takes to the owner; a skill flag goes to its skill's `Owner:`, which may be missing or name no
 * session on the team; the idle pass (T1100) closes and reopens the team's sessions, so a pass that stopped or fails
 * is the whole team's; a repository's git hooks (SECRET-HOOK, T1480) are its own, not one session's area; a secret
 * check turned off (SECRET-GUARD-OFF, T1369) is the owner's call, which the lead takes to the owner. Such a
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

/** A doctor finding no session owns: the context findings, one per budget, the wide allow rules and the missing secret deny lines. */
export type UnownedFinding = ContextFinding | AllowFinding | DenyFinding;

function findingWarning(finding: UnownedFinding): UnownedWarning {
  const text = formatFinding(finding);
  switch (finding.kind) {
    case 'allow-wide':
      return { key: 'permissions allow-wide', source: 'the permissions check [permissions.keepAllow]', text };
    case 'deny-missing':
      return { key: 'permissions deny-missing', source: "the secret deny check of the Claude Code settings' permissions.deny", text };
    default:
      return { key: `context ${finding.budget}`, source: `the context check [contextFiles.${finding.budget}]`, text };
  }
}

function skillWarning(flag: SkillFlag, skillsDir: string): UnownedWarning {
  return { key: `skill ${flag.kind} ${flag.skill}`, source: `the skill check of ${skillsDir}`, text: formatSkillFlag(flag) };
}

/** FLEET-STALE: the idle pass's trouble, keyed by its kind, so a pass failing with a new error is not told again. */
export function idlePassWarning(trouble: IdlePassTrouble, mode: IdleMode, now: number): UnownedWarning {
  return { key: `idle-pass ${trouble.kind}`, source: 'the idle pass check [open.idle.mode]', text: formatIdlePassTrouble(trouble, mode, now) };
}

/**
 * Every doctor finding given is unowned; a skill flag is owned when its owner is a session on the team, else it leaves
 * the skill flags for the unowned ones.
 */
export function splitUnowned(findings: readonly UnownedFinding[], skills: readonly SkillFlag[], sessions: ReadonlySet<string>, skillsDir: string): SplitWarnings {
  const owned = (flag: SkillFlag): boolean => flag.owner !== null && sessions.has(flag.owner);
  return {
    skills: skills.filter(owned),
    unowned: [...findings.map(findingWarning), ...skills.filter((flag) => !owned(flag)).map((flag) => skillWarning(flag, skillsDir))],
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
