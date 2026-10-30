import { join, resolve } from 'node:path';
import { claudeProjectsDir } from "../../budget/discover.js";
import { DEFAULT_PERMISSIONS } from "../../config/defaults.js";
import { claudeConfigDir, KIT_NAME } from "../../core/home.js";
import { expandHome } from "../../core/paths.js";
import { SecretScanner } from "../../core/secrets.js";
import { KeepList } from "../../permissions/allow-rules.js";
import { settingsScope } from "../../permissions/settings-scope.js";
import { coreRuleTexts } from "../../rules/pack.js";
import { isCleared, RULE_HASH_CLOCK, ruleHashesOf, verdictsByText, VerdictStore } from "../../rules/verdicts.js";
import { teamSkillsOf } from "../../setup/backup-places.js";
import { latestBackupOf, listBackups, setupBackupsDir } from "../../setup/backup.js";
import { scanReport } from "../../setup/scan-report.js";
import { BYTES_PER_MB } from "../../setup/scan-unused.js";
import { scanSetup } from "../../setup/scan.js";
import { claudeSkillDoctor } from "../../setup/skill-doctor.js";
import { teamSettingsScope } from "../allow-scope.js";
import { noPositionals, UsageError } from "../args.js";
import { teamFolders, teamProjectOf } from "../kit.js";
import { EXIT } from "../runtime.js";
import { teamRulesPathsOf } from "../team-rules.js";
import { setupTeamOf } from "./setup.js";
/**
 * `setup scan [--project <dir>] [--days <n>] [--max-mb <n>]`: what the user's Claude Code setup costs every turn in a project, and
 * what to slim (src/setup/scan.ts, its lines src/setup/scan-report.ts). It runs before a team exists too, the first
 * step of the team-setup skill; with a team it reads the team's skills folder, its rules file and those of the teams
 * above it, recorded conflicts and rule verdicts, and runs Claude Code's `/skill-doctor` read only. It only reads.
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
/** A flag that takes a whole number of 1 or more, `fallback` when it is not given. */
function wholeFlagOf(args, flag, fallback) {
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
/** The rule lines a stored verdict still clears: none before a team exists. */
async function clearedOf(runtime, team) {
    if (team === undefined) {
        return () => false;
    }
    const hashes = ruleHashesOf(coreRuleTexts(team.config, KIT_NAME, runtime.platform, RULE_HASH_CLOCK));
    const byText = verdictsByText(await new VerdictStore(runtime.files, team.kit.paths.ruleVerdicts).read());
    return (candidate) => isCleared(candidate, byText, hashes);
}
async function settingsOf(runtime, team, claudeDir, project) {
    return team === undefined
        ? settingsScope(runtime.files, claudeDir, [project], runtime.platform)
        : teamSettingsScope(runtime, { paths: team.kit.paths, config: team.config, project });
}
export async function scan(args, runtime) {
    noPositionals(args);
    const days = wholeFlagOf(args, 'days', DEFAULT_SCAN_DAYS);
    const maxMb = wholeFlagOf(args, 'max-mb', DEFAULT_SCAN_MAX_MB);
    const flag = args.flags.get('project');
    const asked = flag === undefined ? undefined : resolve(runtime.cwd, expandHome(flag, runtime.userHome));
    const team = await setupTeamOf(runtime, asked);
    const project = asked ?? (team === undefined ? undefined : teamProjectOf(team.config, team.from)) ?? teamFolders(runtime.env, [])[0] ?? runtime.cwd;
    const claudeDir = claudeConfigDir(runtime.env, runtime.userHome);
    const secrets = new SecretScanner(team?.config.register.secretPatterns);
    const doctor = claudeSkillDoctor({ env: runtime.env, platform: runtime.platform, probe: runtime.probe, files: runtime.files, node: runtime.self.node, hooks: runtime.hooks });
    const found = await scanSetup({ files: runtime.files, probe: runtime.probe, transcripts: runtime.transcripts, doctor }, {
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
    const backups = await listBackups({ files: runtime.files, probe: runtime.probe }, setupBackupsDir(runtime.env, runtime.userHome, runtime.platform));
    const backup = latestBackupOf(backups, { claudeDir, project, teamSkills: teamSkillsOf(team?.kit.paths.skills, claudeDir) });
    const lines = scanReport(found, { project, team: team?.name, days, now: runtime.clock.now(), maxMb, userHome: runtime.userHome, secrets, backup });
    lines.forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
