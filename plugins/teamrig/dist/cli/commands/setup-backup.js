import { join } from 'node:path';
import { claudeConfigDir, KIT_NAME } from "../../core/home.js";
import { readManifest } from "../../setup/backup-manifest.js";
import { SETUP_KINDS } from "../../setup/backup-places.js";
import { applyRestore, planRestore } from "../../setup/backup-restore.js";
import { backupSetup, listBackups, setupBackupsDir, STAMP } from "../../setup/backup.js";
import { noPositionals, UsageError } from "../args.js";
import { EXIT } from "../runtime.js";
import { projectOf } from "./setup.js";
/**
 * `setup backup [--project <dir>]` copies the person's Claude Code setup byte for byte (its CLAUDE.md files, settings,
 * rules, skills, parked skills, agents, commands, output styles and the project's memory) into
 * `<the person's state folder>/teamrig/setup-backups/<UTC second>/` with a manifest of each file's SHA-256, outside the
 * kit home every session reads. `setup restore [<stamp>] [--yes] [--remove-new]` lists the backups, previews one, and
 * with --yes backs the setup up first and then puts the backup's files back. Neither ever prints a file's text.
 */
function portsOf(runtime) {
    return { files: runtime.files, probe: runtime.probe, bytes: runtime.fileBytes };
}
function rootOf(runtime) {
    return setupBackupsDir(runtime.env, runtime.userHome, runtime.platform);
}
function backedUpLines(result) {
    const bytes = result.manifest.files.reduce((sum, entry) => sum + entry.bytes, 0);
    const whys = [...new Set(result.manifest.skipped.map((folder) => folder.why))];
    return [
        `BACKED UP ${result.manifest.files.length} file(s), ${bytes} bytes to ${result.dir}`,
        ...SETUP_KINDS.map((kind) => `  ${kind}: ${result.counts.get(kind) ?? 0} file(s)`),
        ...(whys.length === 0 ? [] : [`  skipped ${result.manifest.skipped.length} folder(s): ${whys.join(', ')}; the manifest lists them`]),
    ];
}
export async function backup(args, runtime) {
    noPositionals(args);
    const at = { claudeDir: claudeConfigDir(runtime.env, runtime.userHome), project: await projectOf(runtime, args.flags.get('project')) };
    const result = await backupSetup(portsOf(runtime), at, rootOf(runtime), runtime.clock.now());
    backedUpLines(result).forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
function listedLine(listed) {
    switch (listed.read.kind) {
        case 'read':
            return `  ${listed.stamp}  ${listed.read.manifest.files.length} file(s)  ${listed.read.manifest.project}`;
        case 'missing':
            return `  ${listed.stamp}  no manifest: the backup did not finish`;
        case 'unreadable':
            return `  ${listed.stamp}  unreadable manifest`;
    }
}
function listLines(root, listed) {
    if (listed.length === 0) {
        return [`NONE no setup backup in ${root} yet; ${KIT_NAME} setup backup makes one`];
    }
    return [`BACKUPS ${listed.length} in ${root}`, ...listed.map(listedLine)];
}
/** The files a restore writes, in the manifest's order. */
function plannedLines(plan) {
    return plan.files.flatMap(({ entry, action }) => {
        if (action === 'restore') {
            return [`  RESTORE ${entry.source}: changed since the backup`];
        }
        return action === 'recreate' ? [`  RECREATE ${entry.source}: deleted since the backup`] : [];
    });
}
function damagedLines(plan) {
    return plan.files.filter((file) => file.action === 'damaged').map((file) => `  DAMAGED ${file.entry.source}: its copy in the backup does not match the manifest; not written`);
}
function newLines(plan, removeNew) {
    const fate = removeNew ? '--remove-new removes it' : 'kept (--remove-new removes it)';
    return plan.added.map((path) => `  NEW ${path}: not in the backup; ${fate}`);
}
function unchangedOf(plan) {
    return plan.files.filter((file) => file.action === 'unchanged').length;
}
/** The preview: each file a restore writes, damages and new files, and UNCHANGED as one count line, as a setup holds hundreds of files. */
function planLines(plan, removeNew) {
    const unchanged = unchangedOf(plan);
    return [...plannedLines(plan), ...damagedLines(plan), ...newLines(plan, removeNew), ...(unchanged === 0 ? [] : [`  UNCHANGED ${unchanged} file(s)`])];
}
const DONE = { restore: 'RESTORED', recreate: 'RECREATED', remove: 'REMOVED' };
function outcomeLine(outcome) {
    return outcome.failed === undefined ? `  ${DONE[outcome.step]} ${outcome.path}` : `  FAILED ${outcome.path}: ${outcome.failed}`;
}
function aboutLine(stamp, manifest) {
    return `setup backup ${stamp} (${manifest.files.length} file(s), made ${manifest.createdAt}) of ${manifest.project}`;
}
export async function restore(args, runtime) {
    const [stamp, extra] = args.positionals;
    if (extra !== undefined) {
        throw new UsageError(`unexpected "${extra}"`);
    }
    const yes = args.switches.has('yes');
    const removeNew = args.switches.has('remove-new');
    const root = rootOf(runtime);
    const ports = portsOf(runtime);
    if (stamp === undefined) {
        if (yes || removeNew) {
            throw new UsageError('setup restore needs a backup stamp before --yes or --remove-new; setup restore lists them');
        }
        listLines(root, await listBackups(ports, root)).forEach((line) => runtime.out.stdout(line));
        return EXIT.ok;
    }
    if (!STAMP.test(stamp)) {
        throw new UsageError(`"${stamp}" is not a backup stamp such as 20261025T120000Z; setup restore lists them`);
    }
    const dir = join(root, stamp);
    const read = await readManifest(runtime.files, dir);
    if (read.kind === 'missing') {
        throw new Error(`no setup backup ${stamp} in ${root}; setup restore lists them`);
    }
    if (read.kind === 'unreadable') {
        throw new Error(`the manifest of setup backup ${stamp} is not one this ${KIT_NAME} wrote; nothing written`);
    }
    const manifest = read.manifest;
    const plan = await planRestore(ports, dir, manifest);
    const damaged = plan.files.some((file) => file.action === 'damaged');
    const writes = plan.files.filter((file) => file.action === 'restore' || file.action === 'recreate').length + (removeNew ? plan.added.length : 0);
    if (writes === 0) {
        const settled = !damaged && plan.added.length === 0;
        runtime.out.stdout(settled ? `UNCHANGED the setup matches setup backup ${stamp}: ${manifest.files.length} file(s)` : `UNCHANGED nothing to write from ${aboutLine(stamp, manifest)}`);
        (settled ? [] : planLines(plan, removeNew)).forEach((line) => runtime.out.stdout(line));
        return damaged ? EXIT.failed : EXIT.ok;
    }
    if (!yes) {
        runtime.out.stdout(`PREVIEW nothing written (add --yes to write): ${aboutLine(stamp, manifest)}`);
        planLines(plan, removeNew).forEach((line) => runtime.out.stdout(line));
        return EXIT.ok;
    }
    const before = await backupSetup(ports, { claudeDir: manifest.claudeDir, project: manifest.project }, root, runtime.clock.now());
    backedUpLines(before).forEach((line) => runtime.out.stdout(line));
    const outcomes = await applyRestore(ports, dir, plan, removeNew);
    const done = outcomes.filter((outcome) => outcome.failed === undefined);
    runtime.out.stdout(`WROTE ${done.length} of ${outcomes.length} file(s) from setup backup ${stamp}; ${unchangedOf(plan)} unchanged`);
    [...outcomes.map(outcomeLine), ...damagedLines(plan), ...(removeNew ? [] : newLines(plan, false))].forEach((line) => runtime.out.stdout(line));
    const recreated = done.some((outcome) => outcome.step === 'recreate');
    runtime.out.stdout(`UNDO ${KIT_NAME} setup restore ${before.stamp} --yes${recreated ? ' --remove-new' : ''}`);
    return damaged || done.length < outcomes.length ? EXIT.failed : EXIT.ok;
}
