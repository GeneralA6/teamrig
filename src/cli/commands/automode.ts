import { kitLines, kitTag, type AutoModeFacts } from '../../automode/lines.ts';
import type { JsonRecord } from '../../core/guards.ts';
import { homeRelative } from '../../core/paths.ts';
import type { HostPermissions, PermissionsAnswer, TrustedRoutesPlan } from '../../ports/host/index.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { checked, readClaudeSettings, settingsTargetOf, writeClaudeSettings } from '../claude-settings.ts';
import { permissionsOf } from '../host.ts';
import { openTeamKit, requireConfig } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';

/**
 * `automode install` and `automode uninstall`: put the team's tagged lines into the host's trusted routes setting, the
 * facts of the setup its automatic approval reads (src/automode/lines.ts), or take them back out. They change the
 * person's own host settings, so they take no `--session`; the lines come from the team's config, so a config change
 * or a teamrig upgrade is picked up by running install again. Without --yes they only show the change; with it, the
 * old settings file is kept in the kit's backups folder first. A host that keeps no permission rule refuses both.
 */

/** `automode install [--yes]`. */
export async function install(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const permissions = permissionsOf(runtime);
  const facts = await factsOf(runtime);
  return apply(args, runtime, permissions, (settings) => permissions.installRoutes(settings, kitTag(facts.team), kitLines(facts)), `team ${facts.team}'s lines are already there`);
}

/** `automode uninstall [--yes]`. */
export async function uninstall(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const permissions = permissionsOf(runtime);
  const { team } = await factsOf(runtime);
  return apply(args, runtime, permissions, (settings) => permissions.uninstallRoutes(settings, kitTag(team)), `team ${team} has no lines there`);
}

async function factsOf(runtime: CliRuntime): Promise<AutoModeFacts> {
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  return {
    team: kit.paths.team,
    home: homeRelative(kit.paths.home, runtime.userHome),
    lead: config.roles.lead,
    pushGuard: config.pushGuard,
  };
}

/** The change to the settings read now. */
type Planner = (settings: JsonRecord) => PermissionsAnswer<TrustedRoutesPlan>;

async function apply(args: ParsedArgs, runtime: CliRuntime, permissions: HostPermissions, plan: Planner, unchanged: string): Promise<ExitCode> {
  const target = settingsTargetOf(runtime);
  const settings = await readClaudeSettings(runtime, target.settingsPath);
  const { settings: next, removed, added } = checked(plan(settings.json));
  if (next === undefined) {
    runtime.out.stdout(`UNCHANGED ${target.settingsPath}: ${unchanged}`);
    return EXIT.ok;
  }
  const where = `${target.settingsPath} ${permissions.routesSetting}`;
  const steps = [...removed.map((item) => `  REMOVE ${where}: ${item}`), ...added.map((item) => `  ADD ${where}: ${item}`)];
  if (!args.switches.has('yes')) {
    runtime.out.stdout('PREVIEW nothing written (add --yes to write)');
    steps.forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
  }
  const backup = await writeClaudeSettings(runtime, target, settings, next);
  runtime.out.stdout(`WROTE the changes below${backup === undefined ? '' : `; the old settings file is at ${backup}`}`);
  steps.forEach((line) => runtime.out.stdout(line));
  return EXIT.ok;
}
