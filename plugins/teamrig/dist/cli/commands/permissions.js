import { join } from 'node:path';
import { KIT_NAME } from "../../core/home.js";
import { KeepList } from "../../permissions/allow-rules.js";
import { planLine, totalLine, writeLine } from "../../permissions/report.js";
import { applyTrim, backupStamp, ownerStateDir, planScope, rewritesOf } from "../../permissions/trim.js";
import { teamSettingsScope } from "../allow-scope.js";
import { noPositionals } from "../args.js";
import { openTeamKit, projectFolder, requireConfig } from "../kit.js";
import { EXIT } from "../runtime.js";
/**
 * `permissions trim [--all] [--yes]`: remove the local allow rules off the team's `permissions.keepAllow` from the
 * Claude Code settings the team's sessions run under (src/cli/allow-scope.ts). By default only the rules that approve
 * a whole tool or a program with any arguments go; `--all` removes every rule off the list. It names each file and
 * counts its rules by class, never printing a rule. Without --yes it writes nothing; with it, each old file goes first
 * to `<the person's state folder>/teamrig/permissions-backups/<UTC second>/` with a manifest, outside the kit home
 * every session reads. Changing permissions is an owner gate, so the owner runs it with --yes.
 */
/** The folder under the person's state folder that keeps each trim's old files. */
const BACKUPS = 'permissions-backups';
export async function trim(args, runtime) {
    noPositionals(args);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const mode = args.switches.has('all') ? 'all' : 'wide';
    const scope = await teamSettingsScope(runtime, { paths: kit.paths, config, project: await projectFolder(runtime, config) });
    const plans = await planScope(runtime.files, scope, new KeepList(config.permissions.keepAllow), mode);
    const lines = plans.flatMap((plan) => planLine(plan) ?? []);
    const what = mode === 'all' ? 'every allow rule' : 'the allow rules that approve a whole tool or program';
    if (rewritesOf(plans).length === 0) {
        runtime.out.stdout(`UNCHANGED no settings file to rewrite holds ${what} off permissions.keepAllow`);
        lines.forEach((line) => runtime.out.stdout(line));
        return EXIT.ok;
    }
    if (!args.switches.has('yes')) {
        runtime.out.stdout(`PREVIEW nothing written (add --yes to write): removes ${what} off permissions.keepAllow`);
        [...lines, totalLine(plans)].forEach((line) => runtime.out.stdout(line));
        return EXIT.ok;
    }
    const now = runtime.clock.now();
    const backupDir = join(ownerStateDir(runtime.env, runtime.userHome, runtime.platform), KIT_NAME, BACKUPS, backupStamp(now));
    const written = await applyTrim(runtime.files, plans, backupDir, now);
    const wrote = written.filter((write) => write.result === 'wrote').length;
    runtime.out.stdout(`WROTE ${wrote} of ${written.length} file(s); their old text and a manifest are in ${backupDir}`);
    written.forEach((write) => runtime.out.stdout(writeLine(write)));
    return wrote === written.length ? EXIT.ok : EXIT.failed;
}
