import { join } from 'node:path';
import { claudeProjectsDir } from '../../budget/discover.ts';
import { launchOf } from '../../config/launch.ts';
import { Roster } from '../../config/roster.ts';
import type { ContextFilesConfig, KitConfig } from '../../config/types.ts';
import { claudeConfigDir, KIT_NAME } from '../../core/home.ts';
import type { PathProbe } from '../../core/path-probe.ts';
import { readContextFiles } from '../../doctor/context-files.ts';
import { readSettingsDeny } from '../../doctor/deny-lines.ts';
import { doctorFindings, formatFinding, type ConfiguredProject, type ContextInput, type SecretDeny } from '../../doctor/doctor.ts';
import { readSessionLists } from '../../doctor/session-lists.ts';
import { claudeSettingsFiles, readSettingsEnv } from '../../doctor/settings-env.ts';
import { readShellHistory } from '../../doctor/shell-history.ts';
import { HiringLog } from '../../hiring/log.ts';
import { retiredSessions } from '../../hiring/record.ts';
import { inboxStatus } from '../../inbox/inbox.ts';
import { JsonlRenameLog } from '../../names/log.ts';
import { readWideAllow } from '../allow-scope.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openTeamKit, projectFolder, requireConfig, teamZone } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { readTeamRules } from '../team-rules.ts';
import { loadTree } from '../tree.ts';
import { inboxDepsOf } from './inbox.ts';

/**
 * What the context findings weigh (`ContextInput`): the CLAUDE.md files, memory index and skill listing of `project`,
 * the user's Claude Code folder and the `skills` folder against `budgets`, and the lists of the project's newest
 * session, its transcript read in chunks. `doctor` and `check` read it.
 */
export async function readContextInput(runtime: CliRuntime, project: string, skills: string, budgets: ContextFilesConfig): Promise<ContextInput> {
  const claudeDir = claudeConfigDir(runtime.env, runtime.userHome);
  return {
    contextFiles: { read: await readContextFiles(runtime.files, { claudeDir, project, skills }), budgets },
    sessionLists: await readSessionLists(runtime.transcripts, claudeProjectsDir(runtime.env, runtime.userHome), project),
  };
}

/** The project folders the config names, `team.project` first, then each session's `launch.<id>.project`, and what is at each. */
async function configuredProjects(probe: PathProbe, config: KitConfig, ids: readonly string[]): Promise<ConfiguredProject[]> {
  const team = config.team?.project;
  const named: readonly Omit<ConfiguredProject, 'kind'>[] = [
    ...(team === undefined ? [] : [{ session: undefined, path: team }]),
    ...ids.flatMap((id) => {
      const path = launchOf(config, id).project;
      return path === undefined ? [] : [{ session: id, path }];
    }),
  ];
  return Promise.all(named.map(async (entry) => ({ ...entry, kind: await probe.kind(entry.path) })));
}

/**
 * The `permissions.deny` lines of the Claude Code settings a session in `project` reads (the user's, then the
 * project's shared and local ones), and the user's file, where the missing secret deny lines go. `doctor` and `check` read it.
 */
export async function readSecretDeny(runtime: CliRuntime, project: string): Promise<SecretDeny> {
  const claudeDir = claudeConfigDir(runtime.env, runtime.userHome);
  const paths = claudeSettingsFiles(claudeDir, project);
  return { files: await readSettingsDeny(runtime.files, paths), pasteInto: join(claudeDir, 'settings.json') };
}

/**
 * `doctor`: what teamrig lacks on this machine (git, Claude Code, Node.js), then the team's health checks
 * (names, the rename log, inboxes, its rules.md beside those of the teams above it, its tree of teams and session names shared with other teams,
 * read from every team config of the kit home), and the text every call of a session in the project re-reads
 * (CLAUDE.md files, the memory index, the skill listing, and the lists of skills, deferred tools, agent types and
 * MCP server instructions the project's newest session transcript announced) against the team's `contextFiles` budgets. Last, what
 * silently overrides the model or effort a session or helper is given: `CLAUDE_CODE_EFFORT_LEVEL` or
 * `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` in doctor's own environment or in the `env` block of the user's or the
 * project's Claude Code settings, a session whose `launch` names a model but no effort, and a `team.project` or
 * `launch.<id>.project` that is no folder on this machine; and the local allow rules off `permissions.keepAllow` that
 * approve a whole tool or program or hold a credential (src/cli/allow-scope.ts); the secret deny lines no settings file
 * holds (src/doctor/deny-lines.ts); and the user's PowerShell history file when no PowerShell profile keeps
 * credentials out of it (src/doctor/shell-history.ts; the history is probed, never read). It reads only and exits 0
 * like `check`: a finding is advice, and each line says the fix. `check` prints the context, allow and deny findings too.
 */
export async function doctor(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const { paths } = kit;
  const renameLog = await new JsonlRenameLog(runtime.files, paths.renames).read();
  const kitTree = await loadTree(runtime);
  const { tree } = kitTree;
  const claudeDir = claudeConfigDir(runtime.env, runtime.userHome);
  const project = await projectFolder(runtime, config);
  const roster = new Roster(config, paths.team, renameLog.renames);
  const { records } = await new HiringLog(runtime.files, paths.hires).read();
  const findings = doctorFindings({
    requirements: await runtime.requirements.problems(),
    roster,
    configNames: config.names,
    renameLog: { ...renameLog, path: paths.renames },
    inboxes: (await inboxStatus(inboxDepsOf(runtime, paths))).map((status) => status.unread),
    retired: new Set(retiredSessions(records).map((record) => record.session)),
    teamRules: (await readTeamRules(runtime, kit, kitTree)).map((rules) => ({ path: rules.path, chars: rules.text.trim().length })),
    ...(await readContextInput(runtime, project, paths.skills, config.contextFiles)),
    tree: { problems: tree.problemsOf(paths.team), clashes: tree.nameClashesOf(paths.team) },
    env: runtime.env,
    settingsEnv: await readSettingsEnv(runtime.files, claudeSettingsFiles(claudeDir, project)),
    settingsDeny: await readSecretDeny(runtime, project),
    wideAllow: await readWideAllow(runtime, { paths, config, project }),
    launches: roster.ids.map((id) => ({ id, launch: launchOf(config, id) })),
    projects: await configuredProjects(runtime.probe, config, roster.ids),
    shellHistory: await readShellHistory(runtime.files, runtime.probe, { env: runtime.env, userHome: runtime.userHome, platform: runtime.platform }),
    budget: config.budget,
    now: new Date(runtime.clock.now()),
    zone: teamZone(config, runtime),
    command: KIT_NAME,
  });
  runtime.out.stdout(findings.length === 0 ? `DOCTOR clean, team ${paths.team}` : `DOCTOR ${findings.length} finding(s), team ${paths.team}`);
  findings.forEach((finding) => runtime.out.stdout(formatFinding(finding)));
  return EXIT.ok;
}
