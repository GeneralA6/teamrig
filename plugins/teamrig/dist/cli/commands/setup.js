import { join, resolve } from 'node:path';
import { launchOf } from "../../config/launch.js";
import { SHIPPED_CONFIG_FORMAT } from "../../config/migrate.js";
import { claudeConfigDir, ENV, KIT_NAME, resolveKitHome, teamPaths } from "../../core/home.js";
import { describeRequirement } from "../../requirements/requirements.js";
import { applyIgnore, ignoreLines, ignoreStep } from "../../setup/pointer-ignore.js";
import { applySetupTask, setupTaskDryLines, setupTaskLines, setupTaskStep } from "../../setup/setup-task.js";
import { tabStatusLine } from "../../setup/tab-status-note.js";
import { applyTeamSetup, planTeamSetup, teamSpecOf } from "../../setup/team-create.js";
import { onePositional, requiredFlag, UsageError } from "../args.js";
import { pointerTeam, resolveTeam } from "../../core/team.js";
import { openKit, requireConfig, teamFolders, teamProjectOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { teamRegister } from "../team-register.js";
import { loadTree } from "../tree.js";
import { titleLeftToHooks } from "./hook-tab-status.js";
/** The session that leads a team created without `--lead`. */
export const DEFAULT_LEAD = 'lead';
/** The project a command sets up: `--project`, else the folder Claude Code started in, else the current folder. */
export async function projectOf(runtime, flag) {
    const given = flag ?? runtime.env[ENV.claudeProjectDir]?.trim();
    const project = resolve(runtime.cwd, given === undefined || given === '' ? '.' : given);
    if ((await runtime.probe.kind(project)) !== 'folder') {
        throw new RefusedError(`the project folder ${project} does not exist`);
    }
    return project;
}
/**
 * The folder a team's session works in: `--project`, else its own `launch.<id>.project`, else the team's
 * ({@link teamProjectOf}), else as {@link projectOf}.
 */
export function sessionProjectOf(runtime, config, id, flag, from) {
    return projectOf(runtime, flag ?? launchOf(config, id).project ?? teamProjectOf(config, from));
}
/** {@link sessionProjectOf} for each session a pass over the team reads. */
export function sessionFoldersOf(runtime, config, flag, from) {
    return (id) => sessionProjectOf(runtime, config, id, flag, from);
}
/**
 * The team of the project a setup command is asked about, by its pointer alone: the caller's `$TEAMRIG_TEAM` names
 * the caller's team, not that project's. Without --project, the caller's team. Undefined before one exists.
 */
export async function setupTeamOf(runtime, asked) {
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
/** One line per file: what the run wrote, or would write, and what it left as it was. */
function stepLines(step, dryRun) {
    if (step.kind === 'keep') {
        return [`UNCHANGED ${step.path}: ${step.why}`];
    }
    return dryRun ? [`WOULD CREATE ${step.path}:`, ...step.text.trimEnd().split('\n')] : [`CREATED ${step.path}`];
}
/** What to do next: a root team's lead adds its first tasks; a sub-team's lead gets its first task from its parent's lead, then opens its own sessions. */
function nextLine(team, lead, parent) {
    if (parent === undefined) {
        return `Next: ${KIT_NAME} add --session ${lead} --owner <id> --priority p<n> --title "<first task>" --description "<what and why>" for each session, then ${KIT_NAME} open <id> for each.`;
    }
    return `Next: ${parent}'s lead runs ${KIT_NAME} add --team ${team} --priority p<n> --title "<first task>" --description "<what and why>", then ${KIT_NAME} open ${team}/${lead}: ${team}'s lead hands its sessions their parts and opens them.`;
}
function summaryLines(plan, ignore, tabStatus, setupTask, dryRun) {
    const { team, lead, sessions, parent } = plan.spec;
    const workers = sessions.filter((id) => id !== lead);
    const lines = [...stepLines(plan.config, dryRun), ...stepLines(plan.pointer, dryRun), ...ignoreLines(ignore, dryRun), tabStatus, ...setupTask];
    if (dryRun) {
        return ['DRY RUN nothing is written', ...lines];
    }
    const under = parent === undefined ? '' : `, under team ${parent}`;
    return [...lines, `Team ${team}${under}: lead ${lead}, sessions ${workers.join(', ')}.`, nextLine(team, lead, parent)];
}
/**
 * A root team's setup task, the lead's first (setup-task.ts): added and started on a team with no tasks yet, kept on
 * a repeat. A sub-team's lead gets its first task from its parent's lead instead. A dry run only reads.
 */
async function setupTaskOf(runtime, spec, dryRun) {
    if (spec.parent !== undefined) {
        return [];
    }
    const kit = await openKit(runtime, spec.team);
    if (dryRun && kit.load.status === 'missing') {
        return setupTaskDryLines({ kind: 'add' }, spec.lead);
    }
    const config = requireConfig(kit, runtime, 'read');
    const register = teamRegister(runtime, kit.paths, config);
    const step = setupTaskStep(await register.snapshot(), spec.lead);
    if (dryRun || step.kind !== 'add') {
        return setupTaskDryLines(step, spec.lead);
    }
    requireConfig(kit, runtime, 'write');
    const outcome = await applySetupTask(register, spec.lead, config.register.ownerSource);
    if (!outcome.ok) {
        throw new RefusedError(`team ${spec.team} is set up, but its setup task was not written (${outcome.problem}); run the command again`);
    }
    return setupTaskLines(outcome.value, spec.lead);
}
/**
 * `team create <team> --sessions a,b [--lead <id>] [--parent <team>] [--project <dir>] [--dry-run]`:
 * writes the team's config in the kit home, tab status on, and the project's pointer to it, kept out of git
 * in this clone (pointer-ignore.ts) whether it is new or was already there, and gives a root team's lead its
 * first task, setting the team up, in progress (setup-task.ts). It says whether the team's tabs
 * will show their status circle, and what the user does if not (tab-status-note.ts). It refuses a different
 * team of the same id, a place in a tree its limits forbid, a session name another team uses, and a
 * project tied to a team outside the new team's tree; a repeat with the same team writes nothing but a missing exclude line. It
 * first says what teamrig lacks on this machine (a `WARN` line each), so a refusal still shows it.
 */
export async function teamCreate(args, runtime) {
    const team = onePositional(args, 'team');
    const spec = teamSpecOf(team, requiredFlag(args.flags, 'sessions'), args.flags.get('lead') ?? DEFAULT_LEAD, args.flags.get('parent'));
    if (!spec.ok) {
        throw new UsageError(spec.problem);
    }
    (await runtime.requirements.problems()).forEach((problem) => runtime.out.stdout(`WARN ${describeRequirement(problem, KIT_NAME)}`));
    const project = await projectOf(runtime, args.flags.get('project'));
    const configPath = teamPaths(resolveKitHome(runtime.env, runtime.userHome), team, claudeConfigDir(runtime.env, runtime.userHome)).config;
    const format = runtime.configFormat ?? SHIPPED_CONFIG_FORMAT;
    const { tree } = await loadTree(runtime);
    const planned = await planTeamSetup(runtime.files, format, spec.value, configPath, project, tree);
    if (!planned.ok) {
        throw new RefusedError(planned.problem);
    }
    const ignore = ignoreStep(runtime.pointerGit, planned.value.pointer.path);
    const dryRun = args.switches.has('dry-run');
    const done = dryRun ? planned : await applyTeamSetup(runtime.files, planned.value);
    if (!done.ok) {
        throw new RefusedError(done.problem);
    }
    if (!dryRun) {
        await applyIgnore(runtime.files, ignore);
    }
    const tabStatus = tabStatusLine({
        team,
        configOn: done.value.tabStatus,
        configPath,
        titleLeft: titleLeftToHooks(runtime.env),
        settingsPath: join(claudeConfigDir(runtime.env, runtime.userHome), 'settings.json'),
    });
    const setupTask = await setupTaskOf(runtime, spec.value, dryRun);
    summaryLines(done.value, ignore, tabStatus, setupTask, dryRun).forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
