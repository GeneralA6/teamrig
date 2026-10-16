import { launchOf } from "../../config/launch.js";
import { Roster } from "../../config/roster.js";
import { claudeConfigDir, KIT_NAME } from "../../core/home.js";
import { readContextFiles } from "../../doctor/context-files.js";
import { doctorFindings, formatFinding } from "../../doctor/doctor.js";
import { claudeSettingsFiles, readSettingsEnv } from "../../doctor/settings-env.js";
import { HiringLog, retiredSessions } from "../../hiring/log.js";
import { inboxStatus } from "../../inbox/inbox.js";
import { JsonlRenameLog } from "../../names/log.js";
import { noPositionals } from "../args.js";
import { openTeamKit, projectFolder, requireConfig } from "../kit.js";
import { EXIT } from "../runtime.js";
import { loadTree } from "../tree.js";
import { inboxDepsOf } from "./inbox.js";
/**
 * `doctor`: what teamrig lacks on this machine (git, Claude Code, Node.js), then the team's health checks
 * (names, the rename log, inboxes, rules.md, its tree of teams and session names shared with other teams,
 * read from every team config of the kit home), and the text every call of a session in the project re-reads
 * (CLAUDE.md files, the memory index, the skill listing) against the team's `contextFiles` budgets. Last, what
 * silently overrides the model or effort a session or helper is given: `CLAUDE_CODE_EFFORT_LEVEL` or
 * `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` in doctor's own environment or in the `env` block of the user's or the
 * project's Claude Code settings, and a session whose `launch` names a model but no effort. It reads only and
 * exits 0 like `check`: a finding is advice, and each line says the fix.
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
    const project = await projectFolder(runtime);
    const roster = new Roster(config, paths.team, renameLog.renames);
    const { records } = await new HiringLog(runtime.files, paths.hires).read();
    const findings = doctorFindings({
        requirements: await runtime.requirements.problems(),
        roster,
        configNames: config.names,
        renameLog: { ...renameLog, path: paths.renames },
        inboxes: await inboxStatus(inboxDepsOf(runtime, paths)),
        retired: new Set(retiredSessions(records).map((record) => record.session)),
        teamRules: rules === undefined ? undefined : { path: paths.teamRules, chars: rules.trim().length },
        contextFiles: {
            read: await readContextFiles(runtime.files, { claudeDir, project, skills: paths.skills }),
            budgets: config.contextFiles,
        },
        tree: { problems: tree.problemsOf(paths.team), clashes: tree.nameClashesOf(paths.team) },
        env: runtime.env,
        settingsEnv: await readSettingsEnv(runtime.files, claudeSettingsFiles(claudeDir, project)),
        launches: roster.ids.map((id) => ({ id, launch: launchOf(config, id) })),
        now: new Date(runtime.clock.now()),
        command: KIT_NAME,
    });
    runtime.out.stdout(findings.length === 0 ? `DOCTOR clean, team ${paths.team}` : `DOCTOR ${findings.length} finding(s), team ${paths.team}`);
    findings.forEach((finding) => runtime.out.stdout(formatFinding(finding)));
    return EXIT.ok;
}
