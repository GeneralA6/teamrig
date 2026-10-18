import { errorMessage } from "../../core/guards.js";
import { resolveKitHome } from "../../core/home.js";
import { RESTORE_LAUNCHER_SCRIPT, restoreLauncherPath } from "../../restore/launcher.js";
import { noPositionals } from "../args.js";
import { EXIT, RefusedError } from "../runtime.js";
/** `restore install [--yes]`. */
export async function restoreInstall(args, runtime) {
    noPositionals(args);
    const { entry, launcher } = machineOf(runtime, 'set up');
    const command = entry.commandFor(runtime.self.node, launcher);
    const before = await entry.read();
    const launcherStale = (await runtime.files.read(launcher)) !== RESTORE_LAUNCHER_SCRIPT;
    const steps = [
        ...(launcherStale ? [{ line: `WRITE ${launcher}`, act: () => runtime.files.write(launcher, RESTORE_LAUNCHER_SCRIPT) }] : []),
        ...(before === command ? [] : [{ line: `SET ${entry.where}: ${before ?? '(none)'} -> ${command}`, act: () => entry.write(command) }]),
    ];
    return apply(args, runtime, steps, `${entry.where}: the restore check already runs at logon`);
}
/** `restore uninstall [--yes]`. */
export async function restoreUninstall(args, runtime) {
    noPositionals(args);
    const { entry, launcher } = machineOf(runtime, 'take out');
    const before = await entry.read();
    const launcherThere = (await runtime.files.read(launcher)) !== undefined;
    const steps = [
        ...(before === undefined ? [] : [{ line: `REMOVE ${entry.where}: ${before}`, act: () => entry.remove() }]),
        ...(launcherThere ? [{ line: `REMOVE ${launcher}`, act: () => runtime.files.remove(launcher) }] : []),
    ];
    return apply(args, runtime, steps, `${entry.where}: the restore check does not run at logon`);
}
/** Shows the steps, or with --yes takes them in order; at the first that fails, says which and what was done before it. */
async function apply(args, runtime, steps, unchanged) {
    if (steps.length === 0) {
        runtime.out.stdout(`UNCHANGED ${unchanged}`);
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
/** The system's logon entry and the launcher it names; refused on a system with no logon entry teamrig can set. */
function machineOf(runtime, verb) {
    const entry = runtime.restore.logon;
    if (entry === undefined) {
        throw new RefusedError(`teamrig can ${verb} the logon check on Windows only so far, not on ${runtime.platform}; after a crash or reboot, run teamrig restore run`);
    }
    return { entry, launcher: restoreLauncherPath(resolveKitHome(runtime.env, runtime.userHome)) };
}
