import { join, resolve } from 'node:path';
import { claudeProjectsDir } from '../../budget/discover.ts';
import { DEFAULT_PERMISSIONS } from '../../config/defaults.ts';
import type { KitConfig } from '../../config/types.ts';
import { claudeConfigDir, KIT_NAME } from '../../core/home.ts';
import { expandHome } from '../../core/paths.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { pointerTeam, resolveTeam } from '../../core/team.ts';
import { KeepList } from '../../permissions/allow-rules.ts';
import { settingsScope, type SettingsFile } from '../../permissions/settings-scope.ts';
import { coreRuleTexts } from '../../rules/pack.ts';
import type { Candidate } from '../../rules/scan.ts';
import { isCleared, RULE_HASH_CLOCK, ruleHashesOf, verdictsByText, VerdictStore } from '../../rules/verdicts.ts';
import { BYTES_PER_MB, scanReport } from '../../setup/scan-report.ts';
import { scanSetup } from '../../setup/scan.ts';
import { teamSettingsScope } from '../allow-scope.ts';
import { noPositionals, UsageError, type ParsedArgs } from '../args.ts';
import { openKit, requireConfig, teamFolders, teamProjectOf, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { teamRulesPathsOf } from '../team-rules.ts';

/**
 * `setup scan [--project <dir>] [--days <n>] [--max-mb <n>]`: what the user's Claude Code setup costs every turn in a project, and
 * what to slim (src/setup/scan.ts, its lines src/setup/scan-report.ts). It runs before a team exists too, the first
 * step of the team-setup skill; with a team it reads the team's skills folder, its rules file and those of the teams
 * above it, recorded conflicts and rule verdicts. It only reads.
 */

/** The days of transcripts that tell which skills are in use, unless --days says otherwise. */
export const DEFAULT_SCAN_DAYS = 30;
/**
 * The MB of those transcripts read, newest first, unless --max-mb says otherwise. T1179's review read one busy day,
 * 330.9 MB, in 30 s (~11 MB/s), and its live run found 4.7 GB in 30 days: a whole month takes minutes, where 1 GB
 * keeps a scan near 90 s.
 */
export const DEFAULT_SCAN_MAX_MB = 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The team a scanned project belongs to, with its config. */
interface ScanTeam {
  readonly name: string;
  readonly kit: Kit;
  readonly config: KitConfig;
  /** The pointer file or `$TEAMRIG_TEAM` the team was found by. */
  readonly from: string;
}

/** A flag that takes a whole number of 1 or more, `fallback` when it is not given. */
function wholeFlagOf(args: ParsedArgs, flag: string, fallback: number): number {
  const text = args.flags.get(flag);
  if (text === undefined) {
    return fallback;
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`--${flag} "${text}" is not a whole number of 1 or more`);
  }
  return value;
}

/**
 * The team of the project the scan is asked about, by its pointer alone: the caller's `$TEAMRIG_TEAM` names the
 * caller's team, not that project's. Without --project, the caller's team. Undefined before one exists.
 */
async function scanTeamOf(runtime: CliRuntime, asked: string | undefined): Promise<ScanTeam | undefined> {
  const found = asked === undefined ? await resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [runtime.cwd])) : await pointerTeam(runtime.files, [asked]);
  switch (found.kind) {
    case 'none':
      return undefined;
    case 'broken':
      throw new RefusedError(`${found.from} ${found.problem}`);
    case 'team': {
      const kit = await openKit(runtime, found.team);
      return { name: found.team, kit, config: requireConfig(kit, runtime, 'read'), from: found.from };
    }
  }
}

/** The rule lines a stored verdict still clears: none before a team exists. */
async function clearedOf(runtime: CliRuntime, team: ScanTeam | undefined): Promise<(candidate: Candidate) => boolean> {
  if (team === undefined) {
    return () => false;
  }
  const hashes = ruleHashesOf(coreRuleTexts(team.config, KIT_NAME, runtime.platform, RULE_HASH_CLOCK));
  const byText = verdictsByText(await new VerdictStore(runtime.files, team.kit.paths.ruleVerdicts).read());
  return (candidate) => isCleared(candidate, byText, hashes);
}

async function settingsOf(runtime: CliRuntime, team: ScanTeam | undefined, claudeDir: string, project: string): Promise<SettingsFile[]> {
  return team === undefined
    ? settingsScope(runtime.files, claudeDir, [project], runtime.platform)
    : teamSettingsScope(runtime, { paths: team.kit.paths, config: team.config, project });
}

export async function scan(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const days = wholeFlagOf(args, 'days', DEFAULT_SCAN_DAYS);
  const maxMb = wholeFlagOf(args, 'max-mb', DEFAULT_SCAN_MAX_MB);
  const flag = args.flags.get('project');
  const asked = flag === undefined ? undefined : resolve(runtime.cwd, expandHome(flag, runtime.userHome));
  const team = await scanTeamOf(runtime, asked);
  const project = asked ?? (team === undefined ? undefined : teamProjectOf(team.config, team.from)) ?? teamFolders(runtime.env, [])[0] ?? runtime.cwd;
  const claudeDir = claudeConfigDir(runtime.env, runtime.userHome);
  const secrets = new SecretScanner(team?.config.register.secretPatterns);
  const found = await scanSetup(runtime, {
    claudeDir,
    userHome: runtime.userHome,
    project,
    skills: team?.kit.paths.skills ?? join(claudeDir, 'skills'),
    teamRules: team === undefined ? [] : await teamRulesPathsOf(runtime, team.kit),
    projectsDir: claudeProjectsDir(runtime.env, runtime.userHome),
    since: runtime.clock.now() - days * DAY_MS,
    maxBytes: maxMb * BYTES_PER_MB,
    settings: await settingsOf(runtime, team, claudeDir, project),
    keep: new KeepList((team?.config.permissions ?? DEFAULT_PERMISSIONS).keepAllow),
    secrets,
    conflicts: team?.config.ruleConflicts ?? [],
    cleared: await clearedOf(runtime, team),
  });
  const lines = scanReport(found, { project, team: team?.name, days, now: runtime.clock.now(), maxMb, userHome: runtime.userHome, secrets });
  lines.forEach((line) => runtime.out.stdout(line));
  return EXIT.ok;
}
