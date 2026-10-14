import { resolve } from 'node:path';
import { SHIPPED_CONFIG_FORMAT } from "../../config/migrate.js";
import { ENV, KIT_NAME, resolveKitHome, teamPaths } from "../../core/home.js";
import { applyTeamSetup, planTeamSetup, teamSpecOf } from "../../setup/team-create.js";
import { onePositional, requiredFlag, UsageError } from "../args.js";
import { EXIT, RefusedError } from "../runtime.js";
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
/** One line per file: what the run wrote, or would write, and what it left as it was. */
function stepLines(step, dryRun) {
    if (step.kind === 'keep') {
        return [`UNCHANGED ${step.path}: ${step.why}`];
    }
    return dryRun ? [`WOULD CREATE ${step.path}:`, ...step.text.trimEnd().split('\n')] : [`CREATED ${step.path}`];
}
function summaryLines(plan, dryRun) {
    const { team, lead, sessions } = plan.spec;
    const workers = sessions.filter((id) => id !== lead);
    const lines = [...stepLines(plan.config, dryRun), ...stepLines(plan.pointer, dryRun)];
    if (dryRun) {
        return ['DRY RUN nothing is written', ...lines];
    }
    return [
        ...lines,
        `Team ${team}: lead ${lead}, sessions ${workers.join(', ')}.`,
        `Next: ${KIT_NAME} add --session ${lead} --owner <id> --tier <n> --title "<first task>" for each session, then ${KIT_NAME} open <id> for each.`,
    ];
}
/**
 * `team create <team> --sessions a,b [--lead <id>] [--project <dir>] [--dry-run]`: writes the team's
 * config in the kit home and the project's pointer to it. It refuses a different team of the same id
 * and a project tied to another team, and a repeat with the same team writes nothing.
 */
export async function teamCreate(args, runtime) {
    const team = onePositional(args, 'team');
    const spec = teamSpecOf(team, requiredFlag(args.flags, 'sessions'), args.flags.get('lead') ?? DEFAULT_LEAD);
    if (!spec.ok) {
        throw new UsageError(spec.problem);
    }
    const project = await projectOf(runtime, args.flags.get('project'));
    const configPath = teamPaths(resolveKitHome(runtime.env, runtime.userHome), team, runtime.userHome).config;
    const format = runtime.configFormat ?? SHIPPED_CONFIG_FORMAT;
    const planned = await planTeamSetup(runtime.files, format, spec.value, configPath, project);
    if (!planned.ok) {
        throw new RefusedError(planned.problem);
    }
    const dryRun = args.switches.has('dry-run');
    const done = dryRun ? planned : await applyTeamSetup(runtime.files, planned.value);
    if (!done.ok) {
        throw new RefusedError(done.problem);
    }
    summaryLines(done.value, dryRun).forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
