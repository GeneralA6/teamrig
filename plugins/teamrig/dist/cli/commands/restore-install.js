import { errorMessage } from "../../core/guards.js";
import { resolveKitHome } from "../../core/home.js";
import { RESTORE_CHECK_LAUNCHER_SCRIPT, RESTORE_RUN_LAUNCHER_SCRIPT, restoreCheckLauncherPath, restoreRunLauncherPath } from "../../restore/launcher.js";
import { RESTORE_SHORTCUT_NAME, restoreShortcut, shortcutLine, shortcutsToRemove, shortcutsToWrite, } from "../../restore/shortcut.js";
import { noPositionals } from "../args.js";
import { EXIT, RefusedError } from "../runtime.js";
/** `restore install [--yes]`. */
export async function restoreInstall(args, runtime) {
    noPositionals(args);
    const { entry, shortcuts, checkLauncher, runLauncher } = machineOf(runtime, 'set up');
    const command = entry.commandFor(runtime.self.node, checkLauncher);
    const before = await entry.read();
    const steps = [
        ...(await writeUnlessThere(runtime, checkLauncher, RESTORE_CHECK_LAUNCHER_SCRIPT)),
        ...(await writeUnlessThere(runtime, runLauncher, RESTORE_RUN_LAUNCHER_SCRIPT)),
        ...(before === command ? [] : [{ line: `SET ${entry.where}: ${before ?? '(none)'} -> ${command}`, act: () => entry.write(command) }]),
    ];
    const unchanged = [`${entry.where}: the restore check already runs at logon`];
    if (shortcuts !== undefined) {
        const wanted = restoreShortcut(runtime.self.node, runLauncher, runtime.userHome);
        const scan = await shortcuts.scan();
        for (const change of shortcutsToWrite(scan, wanted)) {
            steps.push({
                line: `SET ${change.path}: ${change.before === undefined ? '(none)' : shortcutLine(change.before)} -> ${shortcutLine(wanted)}`,
                act: () => shortcuts.write(change.path, wanted),
            });
        }
        unchanged.push(`${scan.startMenu}: the shortcut already runs the restore`);
    }
    return apply(args, runtime, steps, unchanged);
}
/** `restore uninstall [--yes]`. */
export async function restoreUninstall(args, runtime) {
    noPositionals(args);
    const { entry, shortcuts, checkLauncher, runLauncher } = machineOf(runtime, 'take out');
    const before = await entry.read();
    const steps = before === undefined ? [] : [{ line: `REMOVE ${entry.where}: ${before}`, act: () => entry.remove() }];
    const unchanged = [`${entry.where}: the restore check does not run at logon`];
    if (shortcuts !== undefined) {
        for (const found of shortcutsToRemove(await shortcuts.scan(), runLauncher)) {
            steps.push({ line: `REMOVE ${found.path}: ${shortcutLine(found)}`, act: () => shortcuts.remove(found.path) });
        }
        unchanged.push(`no ${RESTORE_SHORTCUT_NAME} runs ${runLauncher}`);
    }
    steps.push(...(await removeIfThere(runtime, checkLauncher)), ...(await removeIfThere(runtime, runLauncher)));
    return apply(args, runtime, steps, unchanged);
}
/** The step that writes `text` at `path`, none when the file there holds it already. */
async function writeUnlessThere(runtime, path, text) {
    return (await runtime.files.read(path)) === text ? [] : [{ line: `WRITE ${path}`, act: () => runtime.files.write(path, text) }];
}
/** The step that removes the file at `path`, none when there is none. */
async function removeIfThere(runtime, path) {
    if ((await runtime.files.read(path)) === undefined) {
        return [];
    }
    return [
        {
            line: `REMOVE ${path}`,
            act: async () => {
                await runtime.files.remove(path);
            },
        },
    ];
}
/** Shows the steps, or with --yes takes them in order; at the first that fails, says which and what was done before it. */
async function apply(args, runtime, steps, unchanged) {
    if (steps.length === 0) {
        unchanged.forEach((line) => runtime.out.stdout(`UNCHANGED ${line}`));
        return EXIT.ok;
    }
    if (!args.switches.has('yes')) {
        runtime.out.stdout('PREVIEW nothing written (add --yes to write)');
        steps.forEach((step) => runtime.out.stdout(`  ${step.line}`));
        return EXIT.ok;
    }
    for (const [index, step] of steps.entries()) {
        try {
            await step.act();
        }
        catch (error) {
            const done = steps.slice(0, index);
            runtime.out.stdout(`FAILED ${step.line}: ${errorMessage(error)}`);
            runtime.out.stdout(done.length === 0 ? '  nothing was changed' : '  done before it:');
            done.forEach((before) => runtime.out.stdout(`  ${before.line}`));
            return EXIT.failed;
        }
    }
    runtime.out.stdout('WROTE the changes below');
    steps.forEach((step) => runtime.out.stdout(`  ${step.line}`));
    return EXIT.ok;
}
/** The system's logon entry and shortcuts, and the launchers they name; refused on a system with no logon entry teamrig can set. */
function machineOf(runtime, verb) {
    const entry = runtime.restore.logon;
    if (entry === undefined) {
        throw new RefusedError(`teamrig can ${verb} the logon check on Windows only so far, not on ${runtime.platform}; after a crash or reboot, run teamrig restore run`);
    }
    const kitHome = resolveKitHome(runtime.env, runtime.userHome);
    return { entry, shortcuts: runtime.restore.shortcuts, checkLauncher: restoreCheckLauncherPath(kitHome), runLauncher: restoreRunLauncherPath(kitHome) };
}
