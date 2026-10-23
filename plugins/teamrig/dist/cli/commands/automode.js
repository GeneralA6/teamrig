import { kitLines, kitTag } from "../../automode/lines.js";
import { AUTO_MODE_KEY, ENVIRONMENT_KEY, planInstall, planUninstall } from "../../automode/install.js";
import { homeRelative } from "../../core/paths.js";
import { noPositionals } from "../args.js";
import { checked, readClaudeSettings, settingsTargetOf, writeClaudeSettings } from "../claude-settings.js";
import { openTeamKit, requireConfig } from "../kit.js";
import { EXIT } from "../runtime.js";
/**
 * `automode install` and `automode uninstall`: put the team's tagged lines into Claude Code's
 * `autoMode.environment` setting, the trusted facts auto mode's classifier reads (src/automode/lines.ts), or take
 * them back out. They change the person's own Claude Code settings, so they take no `--session`; the lines come from
 * the team's config, so a config change or a teamrig upgrade is picked up by running install again. Without --yes
 * they only show the change; with it, the old settings file is kept in the kit's backups folder first.
 */
/** `automode install [--yes]`. */
export async function install(args, runtime) {
    noPositionals(args);
    const facts = await factsOf(runtime);
    return apply(args, runtime, (settings) => planInstall(settings, kitTag(facts.team), kitLines(facts)), `team ${facts.team}'s lines are already there`);
}
/** `automode uninstall [--yes]`. */
export async function uninstall(args, runtime) {
    noPositionals(args);
    const { team } = await factsOf(runtime);
    return apply(args, runtime, (settings) => planUninstall(settings, kitTag(team)), `team ${team} has no lines there`);
}
async function factsOf(runtime) {
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    return {
        team: kit.paths.team,
        home: homeRelative(kit.paths.home, runtime.userHome),
        lead: config.roles.lead,
        pushGuard: config.pushGuard,
    };
}
async function apply(args, runtime, plan, unchanged) {
    const target = settingsTargetOf(runtime);
    const settings = await readClaudeSettings(runtime, target.settingsPath);
    const { settings: next, removed, added } = checked(plan(settings.json));
    if (next === undefined) {
        runtime.out.stdout(`UNCHANGED ${target.settingsPath}: ${unchanged}`);
        return EXIT.ok;
    }
    const where = `${target.settingsPath} ${AUTO_MODE_KEY}.${ENVIRONMENT_KEY}`;
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
