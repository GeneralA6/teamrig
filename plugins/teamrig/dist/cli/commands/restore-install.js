import { errorMessage } from "../../core/guards.js";
import { resolveKitHome } from "../../core/home.js";
import { KIT_VERSION } from "../../core/version.js";
import { restoreLaunchers, restorePlan } from "../../restore/install-plan.js";
import { LAUNCHER_INSTALL_LOCK, launcherRecordPath, lowerRecordSteps } from "../../restore/launcher-refresh.js";
import { RESTORE_SHORTCUT_NAME, shortcutLine, shortcutsToRemove } from "../../restore/shortcut.js";
import { noPositionals } from "../args.js";
import { fileLockOf } from "../file-locks.js";
import { EXIT, RefusedError } from "../runtime.js";
/** `restore install [--yes]`. */
export async function restoreInstall(args, runtime) {
    noPositionals(args);
    const machine = machineOf(runtime, 'set up');
    return underRecordLock(args, runtime, machine.kitHome, async () => {
        const { steps, unchanged } = await restorePlan(machine, 'install');
        const lower = steps.length === 0 ? [] : await lowerRecordSteps(machine.files, machine.kitHome, KIT_VERSION, runtime.clock.now());
        return apply(args, runtime, [...lower, ...steps], unchanged);
    });
}
/** `restore uninstall [--yes]`. */
export async function restoreUninstall(args, runtime) {
    noPositionals(args);
    const { logon, shortcuts, kitHome } = machineOf(runtime, 'take out');
    return underRecordLock(args, runtime, kitHome, async () => {
        const { check, run } = restoreLaunchers(kitHome);
        const before = await logon.read();
        const steps = before === undefined ? [] : [{ line: `REMOVE ${logon.where}: ${before}`, act: () => logon.remove() }];
        const unchanged = [`${logon.where}: the restore check does not run at logon`];
        if (shortcuts !== undefined) {
            for (const found of shortcutsToRemove(await shortcuts.scan(), run.path)) {
                steps.push({ line: `REMOVE ${found.path}: ${shortcutLine(found)}`, act: () => shortcuts.remove(found.path) });
            }
            unchanged.push(`no ${RESTORE_SHORTCUT_NAME} runs ${run.path}`);
        }
        steps.push(...(await removeIfThere(runtime, check.path)), ...(await removeIfThere(runtime, run.path)));
        return apply(args, runtime, steps, unchanged);
    });
}
/** Runs `task` under the launcher record's lock when --yes writes; a preview writes nothing, so it takes no lock. */
async function underRecordLock(args, runtime, kitHome, task) {
    if (!args.switches.has('yes')) {
        return task();
    }
    return fileLockOf(runtime, `${launcherRecordPath(kitHome)}.lock`, LAUNCHER_INSTALL_LOCK).run(task);
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
/** The machine's restore parts, run by this CLI's Node; refused on a system with no logon entry teamrig can set. */
function machineOf(runtime, verb) {
    const logon = runtime.restore.logon;
    if (logon === undefined) {
        throw new RefusedError(`teamrig can ${verb} the logon check on Windows only so far, not on ${runtime.platform}; after a crash or reboot, run teamrig restore run`);
    }
    return {
        files: runtime.files,
        kitHome: resolveKitHome(runtime.env, runtime.userHome),
        node: runtime.self.node,
        userHome: runtime.userHome,
        logon,
        shortcuts: runtime.restore.shortcuts,
    };
}
