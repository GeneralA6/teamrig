import type { TranscriptSource } from '../budget/discover.ts';
import type { RuleConflict } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import type { PathProbe } from '../core/path-probe.ts';
import type { SecretScanner } from '../core/secrets.ts';
import { readSessionLists, type SessionListSource } from '../doctor/session-lists.ts';
import type { KeepList } from '../permissions/allow-rules.ts';
import type { SettingsFile } from '../permissions/settings-scope.ts';
import { scanRules, type Candidate } from '../rules/scan.ts';
import { readSessionContext, type ListedSkill, type SessionContext, type SessionContextLocations } from './scan-context.ts';
import { findDuplicates, type Duplicate } from './scan-duplicates.ts';
import { scanSettings, type SettingsFinding } from './scan-settings.ts';
import { readTranscriptUse, type TranscriptUse } from './scan-usage.ts';
import type { SkillDoctor, SkillDoctorRead } from './skill-doctor.ts';

/**
 * The skill listing every call carries: as the project's newest transcript recorded it (plugins' and built-in skills
 * too), else summed from the user's and project's skill folders.
 */
export interface SkillListing {
  readonly count: number;
  readonly chars: number;
  /** Each source's share, when a transcript recorded the listing; undefined when summed from the folders. */
  readonly sources: readonly SessionListSource[] | undefined;
}

/** What the scan reads through: the setup's files, which paths exist, the machine's transcripts and Claude Code's `/skill-doctor`. */
export interface SetupScanPorts {
  readonly files: Files;
  readonly probe: PathProbe;
  readonly transcripts: TranscriptSource;
  readonly doctor: SkillDoctor;
}

export interface SetupScanInput extends SessionContextLocations {
  /** Claude Code's transcripts folder (`claudeProjectsDir`). */
  readonly projectsDir: string;
  /** Skills used in a transcript written since then count as used. */
  readonly since: number;
  /** The transcripts are read newest first until this many bytes; older ones are left unread. */
  readonly maxBytes: number;
  /** The settings files sessions in the project run under. */
  readonly settings: readonly SettingsFile[];
  readonly keep: KeepList;
  readonly secrets: SecretScanner;
  /** The conflicts the team recorded with `rules keep`; none before a team exists. */
  readonly conflicts: readonly RuleConflict[];
  /** True for a rule line a stored `rules clear` verdict still clears. */
  readonly cleared: (candidate: Candidate) => boolean;
}

export interface SetupScan {
  readonly context: SessionContext;
  readonly listing: SkillListing;
  readonly duplicates: readonly Duplicate[];
  /** The rule lines whose words touch a core rule's topic and no verdict clears. */
  readonly overrides: readonly Candidate[];
  /** How many conflicts the team recorded. */
  readonly recorded: number;
  readonly settings: readonly SettingsFinding[];
  readonly usage: TranscriptUse;
  /** The paths of the listed skills whose file changed since `usage.since`: too new for the transcripts to show unused. */
  readonly recent: ReadonlySet<string>;
  /** Claude Code's own count of each skill's uses on this machine, or why it was not read. */
  readonly doctor: SkillDoctorRead;
}

async function recentSkills(files: Files, skills: readonly ListedSkill[], since: number): Promise<ReadonlySet<string>> {
  const changed = await Promise.all(skills.map(async (skill) => ({ path: skill.path, at: await files.modifiedAt(skill.path) })));
  return new Set(changed.filter(({ at }) => at !== undefined && at >= since).map(({ path }) => path));
}

function folderListing(skills: readonly ListedSkill[]): SkillListing {
  return { count: skills.length, chars: skills.reduce((sum, skill) => sum + skill.line.length, 0), sources: undefined };
}

async function readListing(transcripts: TranscriptSource, at: SetupScanInput, skills: readonly ListedSkill[]): Promise<SkillListing> {
  const recorded = await readSessionLists(transcripts, at.projectsDir, at.project);
  const list = recorded?.lists.find((one) => one.kind === 'skills');
  return list === undefined || list.count === 0 ? folderListing(skills) : { count: list.count, chars: list.chars, sources: list.sources };
}

/**
 * What the user's Claude Code setup costs every turn in `at.project`, and what to slim: the files and skill listing
 * each session loads, the lines they repeat, the rule lines that may override a core rule, the settings findings and
 * the skills no transcript used since `at.since` (or, past `at.maxBytes` of transcripts, in the newest ones read), and
 * which skills changed since the read window starts, with Claude Code's `/skill-doctor` run beside the transcript read.
 * It only reads.
 */
export async function scanSetup(ports: SetupScanPorts, at: SetupScanInput): Promise<SetupScan> {
  const context = await readSessionContext(ports.files, ports.probe, at);
  const rules = await scanRules(ports.files, ports.probe, at, at.conflicts);
  const [usage, doctor] = await Promise.all([
    readTranscriptUse(ports.transcripts, at.projectsDir, { since: at.since, maxBytes: at.maxBytes }),
    ports.doctor.read(at.project),
  ]);
  return {
    context,
    listing: await readListing(ports.transcripts, at, context.skills),
    duplicates: findDuplicates(context.files),
    overrides: rules.candidates.filter((candidate) => !at.cleared(candidate)),
    recorded: rules.recorded.length,
    settings: await scanSettings(ports.files, at.claudeDir, at.settings, at.keep, at.secrets),
    usage,
    recent: await recentSkills(ports.files, context.skills, usage.since),
    doctor,
  };
}
