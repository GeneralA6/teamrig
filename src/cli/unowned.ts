import type { IdleMode } from '../config/types.ts';
import { clipEnd } from '../core/clip.ts';
import { isAbsolute } from 'node:path';
import { KIT_NAME } from '../core/home.ts';
import { homeRelative } from '../core/paths.ts';
import type { Task } from '../register/fold.ts';
import { ACTIVE_STATUSES } from '../register/model.ts';
import { formatFinding, type AllowFinding, type ContextFinding, type DenyFinding } from '../doctor/doctor.ts';
import { formatSkillFlag, type SkillFlag } from '../skills/lint.ts';
import { formatIdlePassTrouble, type IdlePassTrouble } from './idle-pass-log.ts';

/**
 * Warnings no session owns (T951). A context finding weighs text every session on the machine re-reads, so it is no
 * one area's; a wide allow rule or a missing secret deny line sits in settings every session runs under, and a
 * permissions change is the owner's gate, which the lead takes to the owner; a skill flag goes to its skill's `Owner:`, which may be missing or name no
 * session on the team; the idle pass (T1100) closes and reopens the team's sessions, so a pass that stopped or fails
 * is the whole team's; a repository's git hooks (SECRET-HOOK, T1480) are its own, not one session's area; a secret
 * check turned off (SECRET-GUARD-OFF, T1369) is the owner's call, which the lead takes to the owner; a five-hour
 * window near full (FIVE-HOUR, T1968) stalls every session on the account at once; a part of this machine that
 * starts the restore and starts a file gone or something install did not set up (RESTORE-DEAD, RESTORE-STRAY, T2030)
 * is the machine's, every team's on it, so each of their leads hears of it; a state or inbox file near the task
 * pane's read limit (LOG-SIZE, T3482) is the team's state, no one area's. Such a
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
  /**
   * What an open task may name the warning by: the config key of its check, and the file it warns about when it is
   * about one file. A task that names one already covers it, so it is not told as unowned again (#814).
   */
  readonly names?: readonly string[];
}

/** A warning an open task already covers, with that task. */
export interface CoveredWarning {
  readonly warning: UnownedWarning;
  readonly task: Pick<Task, 'id' | 'owner'>;
}

/** The skill flags a session on the team owns, and every warning no session does. */
export interface SplitWarnings {
  readonly skills: readonly SkillFlag[];
  readonly unowned: readonly UnownedWarning[];
}

/** A doctor finding no session owns: the context findings, one per budget, the wide allow rules and the missing secret deny lines. */
export type UnownedFinding = ContextFinding | AllowFinding | DenyFinding;

/**
 * The budgets that total many files: every CLAUDE.md, every skill folder. A task names one of those files for its own
 * reasons ("add a rule to CLAUDE.md", any task about one skill), so only the config key covers such a warning (#814).
 */
const TOTAL_BUDGETS: ReadonlySet<string> = new Set(['maxClaudeMdChars', 'maxSkillListingChars']);

function findingWarning(finding: UnownedFinding): UnownedWarning {
  const text = formatFinding(finding);
  switch (finding.kind) {
    case 'allow-wide':
      return { key: 'permissions allow-wide', source: 'the permissions check [permissions.keepAllow]', text };
    case 'deny-missing':
      return { key: 'permissions deny-missing', source: "the secret deny check of the Claude Code settings' permissions.deny", text };
    default:
      return {
        key: `context ${finding.budget}`,
        source: `the context check [contextFiles.${finding.budget}]`,
        text,
        names: [`contextFiles.${finding.budget}`, ...(TOTAL_BUDGETS.has(finding.budget) ? [] : (finding.paths ?? []))],
      };
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

/**
 * The warnings an open task already covers, each with the first such task in `tasks`' order, and the rest, still
 * unowned. A task covers a warning when its title or description names one of the warning's names, a file under
 * `userHome` by its full path or as `~/...`; a done or dropped
 * task covers nothing, so a warning that comes back after its fix is told again.
 */
export function coverUnowned(
  warnings: readonly UnownedWarning[],
  tasks: Iterable<Task>,
  userHome: string,
): { readonly unowned: UnownedWarning[]; readonly covered: CoveredWarning[] } {
  const open = [...tasks].filter((task) => ACTIVE_STATUSES.includes(task.status));
  // A task names a file under the home folder as `~/...` as often as by its full path (`homeRelative`).
  const formsOf = (name: string): readonly string[] => (isAbsolute(name) ? [name, homeRelative(name, userHome)] : [name]);
  const unowned: UnownedWarning[] = [];
  const covered: CoveredWarning[] = [];
  for (const warning of warnings) {
    const names = (warning.names ?? []).flatMap(formsOf);
    const task = open.find(({ title, description }) => names.some((name) => title.includes(name) || (description ?? '').includes(name)));
    if (task === undefined) {
      unowned.push(warning);
    } else {
      covered.push({ warning, task });
    }
  }
  return { unowned, covered };
}

/** `COVERED 1 warning(s) an open task already covers, so no new task: ...`, the heading `check` prints over them. */
export function coveredHeading(count: number): string {
  return `COVERED ${count} warning(s) an open task already covers, so no new task: work them in that task`;
}

/** `from the context check [contextFiles.maxMemoryIndexChars]: WARN context-size ...; covered by T12 (alpha)`. */
export function coveredRow({ warning, task }: CoveredWarning): string {
  return `${unownedRow(warning)}; covered by ${task.id} (${task.owner})`;
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
