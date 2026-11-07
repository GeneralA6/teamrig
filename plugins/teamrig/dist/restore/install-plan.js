import { RESTORE_CHECK_LAUNCHER_SCRIPT, RESTORE_RUN_LAUNCHER_SCRIPT, restoreCheckLauncherPath, restoreRunLauncherPath } from "./launcher.js";
import { restoreShortcut, sameStart, shortcutLine, shortcutsToWrite } from "./shortcut.js";
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
function partAction(mode, launcherThere) {
    if (mode === 'install') {
        return 'create';
    }
    return launcherThere ? 'repoint' : 'leave';
}
/** The logon entry's plan: it runs the check launcher under `node`. */
async function logonPlan(logon, node, check, action) {
    const command = logon.commandFor(node, check.path);
    const before = await logon.read();
    const writes = action !== 'leave' && before !== command && (action === 'create' || before !== undefined);
    const now = writes ? command : before;
    const registered = now === command ? [{ kind: 'logon', where: logon.where, program: node, script: check.path }] : [];
    const found = now === undefined || now === command ? [] : [{ kind: 'logon', where: logon.where, runs: now }];
    return {
        steps: writes ? [{ line: `SET ${logon.where}: ${before ?? '(none)'} -> ${command}`, act: () => logon.write(command) }] : [],
        unchanged: action === 'leave' ? [] : [`${logon.where}: the restore check already runs at logon`],
        after: { registered, found },
    };
}
/** The shortcuts' plan: each is to start `wanted`, which runs the run launcher at `runLauncher`. */
async function shortcutPlan(shortcuts, wanted, runLauncher, action) {
    const scan = await shortcuts.scan();
    const writes = action === 'leave' ? [] : shortcutsToWrite(scan, wanted).filter((change) => action === 'create' || change.before !== undefined);
    const written = new Set(writes.map((change) => change.path));
    const created = written.has(scan.startMenu) && !scan.found.some((found) => found.path === scan.startMenu);
    const now = [
        ...(created ? [{ path: scan.startMenu, ...wanted }] : []),
        ...scan.found.map((found) => (written.has(found.path) ? { path: found.path, ...wanted } : found)),
    ];
    return {
        steps: writes.map((change) => ({
            line: `SET ${change.path}: ${change.before === undefined ? '(none)' : shortcutLine(change.before)} -> ${shortcutLine(wanted)}`,
            act: () => shortcuts.write(change.path, wanted),
        })),
        unchanged: action === 'leave' ? [] : [`${scan.startMenu}: the shortcut already runs the restore`],
        after: {
            registered: now
                .filter((shortcut) => sameStart(shortcut, wanted))
                .map((shortcut) => ({ kind: 'shortcut', where: shortcut.path, program: wanted.target, script: runLauncher })),
            found: now.filter((shortcut) => !sameStart(shortcut, wanted)).map((shortcut) => ({ kind: 'shortcut', where: shortcut.path, runs: shortcutLine(shortcut) })),
        },
    };
}
/** The changes that bring the machine's restore parts up to date in `mode`; it reads the machine, and changes nothing. */
export async function restorePlan(machine, mode) {
    const { files, logon, shortcuts } = machine;
    const { check, run } = restoreLaunchers(machine.kitHome);
    const [checkThere, runThere] = [await files.read(check.path), await files.read(run.path)];
    const parts = [];
    if (logon !== undefined) {
        parts.push(await logonPlan(logon, machine.node, check, partAction(mode, checkThere !== undefined)));
    }
    if (shortcuts !== undefined) {
        parts.push(await shortcutPlan(shortcuts, restoreShortcut(machine.node, run.path, machine.userHome), run.path, partAction(mode, runThere !== undefined)));
    }
    return {
        steps: [...launcherWrite(files, check, checkThere, mode), ...launcherWrite(files, run, runThere, mode), ...parts.flatMap((part) => part.steps)],
        unchanged: parts.flatMap((part) => part.unchanged),
        after: { registered: parts.flatMap((part) => part.after.registered), found: parts.flatMap((part) => part.after.found) },
    };
}
