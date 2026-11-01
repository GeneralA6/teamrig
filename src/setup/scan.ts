import type { TranscriptSource } from '../budget/discover.ts';
import type { RuleConflict } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import type { PathProbe } from '../core/path-probe.ts';
import type { SecretScanner } from '../core/secrets.ts';
import { readSessionLists, type SessionListKind, type SessionLists, type SessionListSource } from '../doctor/session-lists.ts';
import type { KeepList } from '../permissions/allow-rules.ts';
import type { SettingsFile } from '../permissions/settings-scope.ts';
import { scanRules, type Candidate } from '../rules/scan.ts';
import { readSessionContext, type Listed, type SessionContext, type SessionContextLocations } from './scan-context.ts';
import { findDuplicates, type Duplicate } from './scan-duplicates.ts';
import { scanSettings, type SettingsFinding } from './scan-settings.ts';
import { readTranscriptUse, type TranscriptUse } from './scan-usage.ts';
import type { SkillDoctor, SkillDoctorRead } from './skill-doctor.ts';

/**
 * A listing every call carries, the skills' or the agent types': as the project's newest transcript recorded it
 * (plugins' and built-in ones too), else summed from the user's and project's folders.
 */
export interface Listing {
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
  readonly listing: Listing;
  readonly agentListing: Listing;
  readonly duplicates: readonly Duplicate[];
  /** The rule lines whose words touch a core rule's topic and no verdict clears. */
  readonly overrides: readonly Candidate[];
  /** How many conflicts the team recorded. */
  readonly recorded: number;
  readonly settings: readonly SettingsFinding[];
  readonly usage: TranscriptUse;
  /** The paths of the listed skills and agent types whose file changed since `usage.since`: too new for the transcripts to show unused. */
  readonly recent: ReadonlySet<string>;
  /** Claude Code's own count of each skill's uses on this machine, or why it was not read. */
  readonly doctor: SkillDoctorRead;
}

async function changedSince(files: Files, listed: readonly Listed[], since: number): Promise<ReadonlySet<string>> {
  const changed = await Promise.all(listed.map(async (entry) => ({ path: entry.path, at: await files.modifiedAt(entry.path) })));
  return new Set(changed.filter(({ at }) => at !== undefined && at >= since).map(({ path }) => path));
}

/** The listings the scan sizes. */
type ListingKind = Extract<SessionListKind, 'skills' | 'agents'>;

function folderListing(entries: readonly Listed[]): Listing {
  return { count: entries.length, chars: entries.reduce((sum, entry) => sum + entry.line.length, 0), sources: undefined };
}

/** The `kind` listing as `recorded` holds it, else summed from the `entries` the folders list. */
function listingOf(recorded: SessionLists | undefined, kind: ListingKind, entries: readonly Listed[]): Listing {
  const list = recorded?.lists.find((one) => one.kind === kind);
  return list === undefined || list.count === 0 ? folderListing(entries) : { count: list.count, chars: list.chars, sources: list.sources };
}

/**
 * What the user's Claude Code setup costs every turn in `at.project`, and what to slim: the files and the skill and
 * agent type listings each session loads, the lines they repeat, the rule lines that may override a core rule, the
 * settings findings, where each skill and agent type was used since `at.since` (or, past `at.maxBytes` of transcripts,
 * in the newest ones read), and which of them changed since the read window starts, with Claude Code's
 * `/skill-doctor` run beside the transcript read.
 * It only reads.
 */
export async function scanSetup(ports: SetupScanPorts, at: SetupScanInput): Promise<SetupScan> {
  const context = await readSessionContext(ports.files, ports.probe, at);
  const rules = await scanRules(ports.files, ports.probe, at, at.conflicts);
  const [usage, doctor] = await Promise.all([
    readTranscriptUse(ports.transcripts, at.projectsDir, { since: at.since, maxBytes: at.maxBytes }),
    ports.doctor.read(at.project),
  ]);
  const recorded = await readSessionLists(ports.transcripts, at.projectsDir, at.project);
  return {
    context,
    listing: listingOf(recorded, 'skills', context.skills),
    agentListing: listingOf(recorded, 'agents', context.agents),
    duplicates: findDuplicates(context.files),
    overrides: rules.candidates.filter((candidate) => !at.cleared(candidate)),
    recorded: rules.recorded.length,
    settings: await scanSettings(ports.files, at.claudeDir, at.settings, at.keep, at.secrets, usage.hooks),
    usage,
    recent: await changedSince(ports.files, [...context.skills, ...context.agents], usage.since),
    doctor,
  };
}
