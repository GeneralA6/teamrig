import { resolveKitHome } from "../../core/home.js";
import { KIT_VERSION } from "../../core/version.js";
import { lowerRecordSteps } from "../../restore/launcher-refresh.js";
import { planInstall, planUninstall, STATUS_LINE_KEY } from "../../statusline/install.js";
import { LAUNCHER_SCRIPT, launcherPath } from "../../statusline/launcher.js";
import { noPositionals } from "../args.js";
import { checked, readClaudeSettings, settingsTargetOf, writeClaudeSettings } from "../claude-settings.js";
import { underRecordLock } from "../launcher-record-lock.js";
import { EXIT } from "../runtime.js";
/** `statusline install [--yes]`. */
export async function install(args, runtime) {
    noPositionals(args);
    const machine = machineOf(runtime);
    return underRecordLock(args, runtime, machine.kitHome, async () => {
        const settings = await readClaudeSettings(runtime, machine.settingsPath);
        const plan = checked(planInstall(settings.json, machine.launcher));
        const launcherStale = (await runtime.files.read(machine.launcher)) !== LAUNCHER_SCRIPT;
        const lower = launcherStale ? await lowerRecordSteps(runtime.files, machine.kitHome, KIT_VERSION, runtime.clock.now()) : [];
        return apply(args, runtime, { machine, settings, plan, lower, launcher: launcherStale ? 'write' : undefined }, 'teamrig is already the status line');
    });
}
/** `statusline uninstall [--yes]`. */
export async function uninstall(args, runtime) {
    noPositionals(args);
    const machine = machineOf(runtime);
    return underRecordLock(args, runtime, machine.kitHome, async () => {
        const settings = await readClaudeSettings(runtime, machine.settingsPath);
        const plan = checked(planUninstall(settings.json, machine.launcher));
        const launcherThere = (await runtime.files.read(machine.launcher)) !== undefined;
        return apply(args, runtime, { machine, settings, plan, lower: [], launcher: launcherThere ? 'remove' : undefined }, 'teamrig is not the status line');
    });
}
async function apply(args, runtime, change, unchanged) {
    const { machine, plan } = change;
    const next = plan.settings;
    if (next === undefined && change.launcher === undefined) {
        runtime.out.stdout(`UNCHANGED ${machine.settingsPath}: ${unchanged}`);
        return EXIT.ok;
    }
    const steps = [
        ...change.lower.map((step) => `  ${step.line}`),
        ...(change.launcher === 'write' ? [`  WRITE ${machine.launcher}`] : []),
        ...(next === undefined ? [] : [`  CHANGE ${machine.settingsPath} ${STATUS_LINE_KEY}.command: ${shown(plan.before)} -> ${shown(plan.after)}`]),
        ...(change.launcher === 'remove' ? [`  REMOVE ${machine.launcher}`] : []),
    ];
    if (!args.switches.has('yes')) {
        runtime.out.stdout('PREVIEW nothing written (add --yes to write)');
        steps.forEach((line) => runtime.out.stdout(line));
        return EXIT.ok;
    }
    for (const step of change.lower) {
        await step.act();
    }
    if (change.launcher === 'write') {
        await runtime.files.write(machine.launcher, LAUNCHER_SCRIPT);
    }
    const backup = next === undefined ? undefined : await writeClaudeSettings(runtime, machine, change.settings, next);
    if (change.launcher === 'remove') {
        await runtime.files.remove(machine.launcher);
    }
    runtime.out.stdout(`WROTE the changes below${backup === undefined ? '' : `; the old settings file is at ${backup}`}`);
    steps.forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
function machineOf(runtime) {
    const kitHome = resolveKitHome(runtime.env, runtime.userHome);
    return { ...settingsTargetOf(runtime), kitHome, launcher: launcherPath(kitHome) };
}
function shown(command) {
    return command ?? '(none)';
}
