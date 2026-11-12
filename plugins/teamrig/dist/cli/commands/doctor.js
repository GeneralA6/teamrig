import { join } from 'node:path';
import { claudeProjectsDir } from "../../budget/discover.js";
import { launchOf } from "../../config/launch.js";
import { Roster } from "../../config/roster.js";
import { claudeConfigDir, KIT_NAME } from "../../core/home.js";
import { readContextFiles } from "../../doctor/context-files.js";
import { readSettingsDeny } from "../../doctor/deny-lines.js";
import { doctorFindings, formatFinding } from "../../doctor/doctor.js";
import { readSessionLists } from "../../doctor/session-lists.js";
import { claudeSettingsFiles, readSettingsEnv } from "../../doctor/settings-env.js";
import { readShellHistory } from "../../doctor/shell-history.js";
import { HiringLog } from "../../hiring/log.js";
import { retiredSessions } from "../../hiring/record.js";
import { inboxStatus } from "../../inbox/inbox.js";
import { JsonlRenameLog } from "../../names/log.js";
import { readWideAllow } from "../allow-scope.js";
import { noPositionals } from "../args.js";
import { openTeamKit, projectFolder, requireConfig, teamZone } from "../kit.js";
import { pageCheckOf } from "../login-page.js";
import { EXIT } from "../runtime.js";
import { readTeamRules } from "../team-rules.js";
import { loadTree } from "../tree.js";
import { inboxDepsOf } from "./inbox.js";
/**
 * What the context findings weigh (`ContextInput`): the CLAUDE.md files, memory index and skill listing of `project`,
 * the user's Claude Code folder and the `skills` folder against `budgets`, and the lists of the project's newest
 * session, its transcript read in chunks. `doctor` and `check` read it.
 */
export async function readContextInput(runtime, project, skills, budgets) {
    const claudeDir = claudeConfigDir(runtime.env, runtime.userHome);
    return {
        contextFiles: { read: await readContextFiles(runtime.files, { claudeDir, project, skills }), budgets },
        sessionLists: await readSessionLists(runtime.transcripts, claudeProjectsDir(runtime.env, runtime.userHome), project),
    };
}
/** The project folders the config names, `team.project` first, then each session's `launch.<id>.project`, and what is at each. */
async function configuredProjects(probe, config, ids) {
    const team = config.team?.project;
    const named = [
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
export async function readSecretDeny(runtime, project) {
    const claudeDir = claudeConfigDir(runtime.env, runtime.userHome);
    const paths = claudeSettingsFiles(claudeDir, project);
    return { files: await readSettingsDeny(runtime.files, paths), pasteInto: join(claudeDir, 'settings.json') };
}
/** The doctor's view of a page check: only a page webhook that gives no URL is a finding. */
function pageProblemOf(check) {
    return check.status === 'problem' ? { team: check.source.team, key: check.source.key, problem: check.problem } : undefined;
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
 * credentials out of it (src/doctor/shell-history.ts; the history is probed, never read); and a page webhook the team's
 * alerts name that resolves to no https URL (src/cli/login-page.ts; resolved, never posted or printed). It reads only and exits 0
 * like `check`: a finding is advice, and each line says the fix. `check` prints the context, allow and deny findings too.
 */
export async function doctor(args, runtime) {
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
        page: pageProblemOf(await pageCheckOf(runtime, paths.team)),
        budget: config.budget,
        now: new Date(runtime.clock.now()),
        zone: teamZone(config, runtime),
        command: KIT_NAME,
    });
    runtime.out.stdout(findings.length === 0 ? `DOCTOR clean, team ${paths.team}` : `DOCTOR ${findings.length} finding(s), team ${paths.team}`);
    findings.forEach((finding) => runtime.out.stdout(formatFinding(finding)));
    return EXIT.ok;
}
