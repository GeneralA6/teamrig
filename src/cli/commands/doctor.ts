import { claudeProjectsDir } from '../../budget/discover.ts';
import { launchOf } from '../../config/launch.ts';
import { Roster } from '../../config/roster.ts';
import { claudeConfigDir, KIT_NAME } from '../../core/home.ts';
import { readContextFiles } from '../../doctor/context-files.ts';
import { doctorFindings, formatFinding } from '../../doctor/doctor.ts';
import { readSessionLists } from '../../doctor/session-lists.ts';
import { claudeSettingsFiles, readSettingsEnv } from '../../doctor/settings-env.ts';
import { HiringLog, retiredSessions } from '../../hiring/log.ts';
import { inboxStatus } from '../../inbox/inbox.ts';
import { JsonlRenameLog } from '../../names/log.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openTeamKit, projectFolder, requireConfig, teamZone } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { inboxDepsOf } from './inbox.ts';

/**
 * `doctor`: what teamrig lacks on this machine (git, Claude Code, Node.js), then the team's health checks
 * (names, the rename log, inboxes, rules.md, its tree of teams and session names shared with other teams,
 * read from every team config of the kit home), and the text every call of a session in the project re-reads
 * (CLAUDE.md files, the memory index, the skill listing, and the lists of skills, deferred tools, agent types and
 * MCP server instructions the project's newest session transcript announced) against the team's `contextFiles` budgets. Last, what
 * silently overrides the model or effort a session or helper is given: `CLAUDE_CODE_EFFORT_LEVEL` or
 * `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` in doctor's own environment or in the `env` block of the user's or the
 * project's Claude Code settings, and a session whose `launch` names a model but no effort. It reads only and
 * exits 0 like `check`: a finding is advice, and each line says the fix.
 */
export async function doctor(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const { paths } = kit;
  const renameLog = await new JsonlRenameLog(runtime.files, paths.renames).read();
  const rules = await runtime.files.read(paths.teamRules);
  const { tree } = await loadTree(runtime);
  const claudeDir = claudeConfigDir(runtime.env, runtime.userHome);
  const project = await projectFolder(runtime);
  const roster = new Roster(config, paths.team, renameLog.renames);
  const { records } = await new HiringLog(runtime.files, paths.hires).read();
  const findings = doctorFindings({
    requirements: await runtime.requirements.problems(),
    roster,
    configNames: config.names,
    renameLog: { ...renameLog, path: paths.renames },
    inboxes: (await inboxStatus(inboxDepsOf(runtime, paths))).map((status) => status.unread),
    retired: new Set(retiredSessions(records).map((record) => record.session)),
    teamRules: rules === undefined ? undefined : { path: paths.teamRules, chars: rules.trim().length },
    contextFiles: {
      read: await readContextFiles(runtime.files, { claudeDir, project, skills: paths.skills }),
      budgets: config.contextFiles,
    },
    sessionLists: await readSessionLists(runtime.transcripts, claudeProjectsDir(runtime.env, runtime.userHome), project),
    tree: { problems: tree.problemsOf(paths.team), clashes: tree.nameClashesOf(paths.team) },
    env: runtime.env,
    settingsEnv: await readSettingsEnv(runtime.files, claudeSettingsFiles(claudeDir, project)),
    launches: roster.ids.map((id) => ({ id, launch: launchOf(config, id) })),
    now: new Date(runtime.clock.now()),
    zone: teamZone(config, runtime),
    command: KIT_NAME,
  });
  runtime.out.stdout(findings.length === 0 ? `DOCTOR clean, team ${paths.team}` : `DOCTOR ${findings.length} finding(s), team ${paths.team}`);
  findings.forEach((finding) => runtime.out.stdout(formatFinding(finding)));
  return EXIT.ok;
}
