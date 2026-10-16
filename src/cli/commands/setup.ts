import { resolve } from 'node:path';
import { SHIPPED_CONFIG_FORMAT } from '../../config/migrate.ts';
import { ENV, KIT_NAME, resolveKitHome, teamPaths } from '../../core/home.ts';
import { describeRequirement } from '../../requirements/requirements.ts';
import { applyTeamSetup, planTeamSetup, teamSpecOf, type FileStep, type SetupPlan } from '../../setup/team-create.ts';
import { onePositional, requiredFlag, UsageError, type ParsedArgs } from '../args.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';

/** The session that leads a team created without `--lead`. */
export const DEFAULT_LEAD = 'lead';

/** The project a command sets up: `--project`, else the folder Claude Code started in, else the current folder. */
export async function projectOf(runtime: CliRuntime, flag: string | undefined): Promise<string> {
  const given = flag ?? runtime.env[ENV.claudeProjectDir]?.trim();
  const project = resolve(runtime.cwd, given === undefined || given === '' ? '.' : given);
  if ((await runtime.probe.kind(project)) !== 'folder') {
    throw new RefusedError(`the project folder ${project} does not exist`);
  }
  return project;
}

/** One line per file: what the run wrote, or would write, and what it left as it was. */
function stepLines(step: FileStep, dryRun: boolean): string[] {
  if (step.kind === 'keep') {
    return [`UNCHANGED ${step.path}: ${step.why}`];
  }
  return dryRun ? [`WOULD CREATE ${step.path}:`, ...step.text.trimEnd().split('\n')] : [`CREATED ${step.path}`];
}

/** What to do next: a root team's lead adds its first tasks; a sub-team's lead gets its first task from its parent's lead, then opens its own sessions. */
function nextLine(team: string, lead: string, parent: string | undefined): string {
  if (parent === undefined) {
    return `Next: ${KIT_NAME} add --session ${lead} --owner <id> --priority p<n> --title "<first task>" --description "<what and why>" for each session, then ${KIT_NAME} open <id> for each.`;
  }
  return `Next: ${parent}'s lead runs ${KIT_NAME} add --team ${team} --priority p<n> --title "<first task>" --description "<what and why>", then ${KIT_NAME} open ${team}/${lead}: ${team}'s lead hands its sessions their parts and opens them.`;
}

function summaryLines(plan: SetupPlan, dryRun: boolean): string[] {
  const { team, lead, sessions, parent } = plan.spec;
  const workers = sessions.filter((id) => id !== lead);
  const lines = [...stepLines(plan.config, dryRun), ...stepLines(plan.pointer, dryRun)];
  if (dryRun) {
    return ['DRY RUN nothing is written', ...lines];
  }
  const under = parent === undefined ? '' : `, under team ${parent}`;
  return [...lines, `Team ${team}${under}: lead ${lead}, sessions ${workers.join(', ')}.`, nextLine(team, lead, parent)];
}

/**
 * `team create <team> --sessions a,b [--lead <id>] [--parent <team>] [--project <dir>] [--dry-run]`:
 * writes the team's config in the kit home and the project's pointer to it. It refuses a different
 * team of the same id, a place in a tree its limits forbid, a session name another team uses, and a
 * project tied to a team outside the new team's tree; a repeat with the same team writes nothing. It
 * first says what teamrig lacks on this machine (a `WARN` line each), so a refusal still shows it.
 */
export async function teamCreate(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const team = onePositional(args, 'team');
  const spec = teamSpecOf(team, requiredFlag(args.flags, 'sessions'), args.flags.get('lead') ?? DEFAULT_LEAD, args.flags.get('parent'));
  if (!spec.ok) {
    throw new UsageError(spec.problem);
  }
  (await runtime.requirements.problems()).forEach((problem) => runtime.out.stdout(`WARN ${describeRequirement(problem, KIT_NAME)}`));
  const project = await projectOf(runtime, args.flags.get('project'));
  const configPath = teamPaths(resolveKitHome(runtime.env, runtime.userHome), team, runtime.userHome).config;
  const format = runtime.configFormat ?? SHIPPED_CONFIG_FORMAT;
  const { tree } = await loadTree(runtime);
  const planned = await planTeamSetup(runtime.files, format, spec.value, configPath, project, tree);
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
