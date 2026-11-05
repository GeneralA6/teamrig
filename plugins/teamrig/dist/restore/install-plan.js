import { RESTORE_CHECK_LAUNCHER_SCRIPT, RESTORE_RUN_LAUNCHER_SCRIPT, restoreCheckLauncherPath, restoreRunLauncherPath } from "./launcher.js";
import { restoreShortcut, shortcutLine, shortcutsToWrite } from "./shortcut.js";
/** The restore's two launchers under the kit home. */
export function restoreLaunchers(kitHome) {
    return {
        check: { path: restoreCheckLauncherPath(kitHome), text: RESTORE_CHECK_LAUNCHER_SCRIPT },
        run: { path: restoreRunLauncherPath(kitHome), text: RESTORE_RUN_LAUNCHER_SCRIPT },
    };
}
/** The step that writes `launcher` over `there` (the text the file holds now, undefined for none), when `mode` calls for one. */
function launcherWrite(files, launcher, there, mode) {
    const due = there !== launcher.text && (mode === 'install' || there !== undefined);
    return due ? [{ line: `WRITE ${launcher.path}`, act: () => files.write(launcher.path, launcher.text) }] : [];
}
/** The step that writes `launcher` when `mode` calls for one, reading the file first. */
export async function launcherStep(files, launcher, mode) {
    return launcherWrite(files, launcher, await files.read(launcher.path), mode);
}
/** The changes that bring the machine's restore parts up to date in `mode`; it reads the machine, and changes nothing. */
export async function restorePlan(machine, mode) {
    const { files, logon, shortcuts } = machine;
    const install = mode === 'install';
    const { check, run } = restoreLaunchers(machine.kitHome);
    const [checkThere, runThere] = [await files.read(check.path), await files.read(run.path)];
    const steps = [...launcherWrite(files, check, checkThere, mode), ...launcherWrite(files, run, runThere, mode)];
    const unchanged = [];
    if (logon !== undefined && (install || checkThere !== undefined)) {
        const command = logon.commandFor(machine.node, check.path);
        const before = await logon.read();
        if (before !== command && (install || before !== undefined)) {
            steps.push({ line: `SET ${logon.where}: ${before ?? '(none)'} -> ${command}`, act: () => logon.write(command) });
        }
        unchanged.push(`${logon.where}: the restore check already runs at logon`);
    }
    if (shortcuts !== undefined && (install || runThere !== undefined)) {
        const wanted = restoreShortcut(machine.node, run.path, machine.userHome);
        const scan = await shortcuts.scan();
        for (const change of shortcutsToWrite(scan, wanted)) {
            if (install || change.before !== undefined) {
                steps.push({
                    line: `SET ${change.path}: ${change.before === undefined ? '(none)' : shortcutLine(change.before)} -> ${shortcutLine(wanted)}`,
                    act: () => shortcuts.write(change.path, wanted),
                });
            }
        }
        unchanged.push(`${scan.startMenu}: the shortcut already runs the restore`);
    }
    return { steps, unchanged };
}
