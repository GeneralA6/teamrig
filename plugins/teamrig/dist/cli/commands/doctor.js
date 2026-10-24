import { claudeProjectsDir } from "../../budget/discover.js";
import { launchOf } from "../../config/launch.js";
import { Roster } from "../../config/roster.js";
import { claudeConfigDir, KIT_NAME } from "../../core/home.js";
import { readContextFiles } from "../../doctor/context-files.js";
import { doctorFindings, formatFinding } from "../../doctor/doctor.js";
import { readSessionLists } from "../../doctor/session-lists.js";
import { claudeSettingsFiles, readSettingsEnv } from "../../doctor/settings-env.js";
import { HiringLog, retiredSessions } from "../../hiring/log.js";
import { inboxStatus } from "../../inbox/inbox.js";
import { JsonlRenameLog } from "../../names/log.js";
import { readWideAllow } from "../allow-scope.js";
import { noPositionals } from "../args.js";
import { openTeamKit, projectFolder, requireConfig, teamZone } from "../kit.js";
import { EXIT } from "../runtime.js";
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
 * `doctor`: what teamrig lacks on this machine (git, Claude Code, Node.js), then the team's health checks
 * (names, the rename log, inboxes, rules.md, its tree of teams and session names shared with other teams,
 * read from every team config of the kit home), and the text every call of a session in the project re-reads
 * (CLAUDE.md files, the memory index, the skill listing, and the lists of skills, deferred tools, agent types and
 * MCP server instructions the project's newest session transcript announced) against the team's `contextFiles` budgets. Last, what
 * silently overrides the model or effort a session or helper is given: `CLAUDE_CODE_EFFORT_LEVEL` or
 * `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` in doctor's own environment or in the `env` block of the user's or the
 * project's Claude Code settings, a session whose `launch` names a model but no effort, and a `team.project` or
 * `launch.<id>.project` that is no folder on this machine; and the local allow rules off `permissions.keepAllow` that
 * approve a whole tool or program (src/cli/allow-scope.ts). It reads only and
 * exits 0 like `check`: a finding is advice, and each line says the fix. `check` prints the context and allow findings too.
 */
export async function doctor(args, runtime) {
    noPositionals(args);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const { paths } = kit;
    const renameLog = await new JsonlRenameLog(runtime.files, paths.renames).read();
    const rules = await runtime.files.read(paths.teamRules);
    const { tree } = await loadTree(runtime);
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
        teamRules: rules === undefined ? undefined : { path: paths.teamRules, chars: rules.trim().length },
        ...(await readContextInput(runtime, project, paths.skills, config.contextFiles)),
        tree: { problems: tree.problemsOf(paths.team), clashes: tree.nameClashesOf(paths.team) },
        env: runtime.env,
        settingsEnv: await readSettingsEnv(runtime.files, claudeSettingsFiles(claudeDir, project)),
        wideAllow: await readWideAllow(runtime, { paths, config, project }),
        launches: roster.ids.map((id) => ({ id, launch: launchOf(config, id) })),
        projects: await configuredProjects(runtime.probe, config, roster.ids),
        now: new Date(runtime.clock.now()),
        zone: teamZone(config, runtime),
        command: KIT_NAME,
    });
    runtime.out.stdout(findings.length === 0 ? `DOCTOR clean, team ${paths.team}` : `DOCTOR ${findings.length} finding(s), team ${paths.team}`);
    findings.forEach((finding) => runtime.out.stdout(formatFinding(finding)));
    return EXIT.ok;
}
