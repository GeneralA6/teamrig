import { Roster } from "../../config/roster.js";
import { KIT_NAME } from "../../core/home.js";
import { doctorFindings, formatFinding } from "../../doctor/doctor.js";
import { inboxStatus } from "../../inbox/inbox.js";
import { JsonlRenameLog } from "../../names/log.js";
import { noPositionals } from "../args.js";
import { openTeamKit, requireConfig } from "../kit.js";
import { EXIT } from "../runtime.js";
import { loadTree } from "../tree.js";
import { inboxDepsOf } from "./inbox.js";
/**
 * `doctor`: what teamrig lacks on this machine (git, Claude Code, Node.js), then the team's health checks
 * (names, the rename log, inboxes, rules.md, its tree of teams and session names shared with other teams,
 * read from every team config of the kit home). It reads only and exits 0 like `check`: a finding is
 * advice, and each line says the fix.
 */
export async function doctor(args, runtime) {
    noPositionals(args);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const { paths } = kit;
    const renameLog = await new JsonlRenameLog(runtime.files, paths.renames).read();
    const rules = await runtime.files.read(paths.teamRules);
    const { tree } = await loadTree(runtime);
    const findings = doctorFindings({
        requirements: await runtime.requirements.problems(),
        roster: new Roster(config, paths.team, renameLog.renames),
        configNames: config.names,
        renameLog: { ...renameLog, path: paths.renames },
        inboxes: await inboxStatus(inboxDepsOf(runtime, paths)),
        teamRules: rules === undefined ? undefined : { path: paths.teamRules, chars: rules.trim().length },
        tree: { problems: tree.problemsOf(paths.team), clashes: tree.nameClashesOf(paths.team) },
        now: new Date(runtime.clock.now()),
        command: KIT_NAME,
    });
    runtime.out.stdout(findings.length === 0 ? `DOCTOR clean, team ${paths.team}` : `DOCTOR ${findings.length} finding(s), team ${paths.team}`);
    findings.forEach((finding) => runtime.out.stdout(formatFinding(finding)));
    return EXIT.ok;
}
