import { join } from 'node:path';
import { formatConfig, writeConfigWithBackup } from "../../config/load.js";
import { errorMessage, isRecord } from "../../core/guards.js";
import { claudeConfigDir, resolveKitHome } from "../../core/home.js";
import { planInstall, planUninstall, STATUS_LINE_KEY } from "../../statusline/install.js";
import { LAUNCHER_SCRIPT, launcherPath } from "../../statusline/launcher.js";
import { noPositionals } from "../args.js";
import { EXIT, RefusedError } from "../runtime.js";
/**
 * `statusline install` and `statusline uninstall`: make `teamrig statusline` Claude Code's status line, or
 * take it back out. They change the person's own Claude Code settings on this machine, not a team's, so
 * any session or person may run them. Without --yes they only show the change; with it, the old settings
 * file is kept in the kit's backups folder first. The launcher is written before the settings name it,
 * and removed only after they stop naming it.
 */
/** The backup name of Claude Code's settings before a status line change. */
const SETTINGS_BACKUP_NAME = 'claude-settings';
/** `statusline install [--yes]`. */
export async function install(args, runtime) {
    noPositionals(args);
    const machine = machineOf(runtime);
    const settings = await readSettings(runtime, machine.settingsPath);
    const plan = checked(planInstall(settings.json, machine.launcher));
    const launcherStale = (await runtime.files.read(machine.launcher)) !== LAUNCHER_SCRIPT;
    return apply(args, runtime, { machine, settings, plan, launcher: launcherStale ? 'write' : undefined }, 'teamrig is already the status line');
}
/** `statusline uninstall [--yes]`. */
export async function uninstall(args, runtime) {
    noPositionals(args);
    const machine = machineOf(runtime);
    const settings = await readSettings(runtime, machine.settingsPath);
    const plan = checked(planUninstall(settings.json, machine.launcher));
    const launcherThere = (await runtime.files.read(machine.launcher)) !== undefined;
    return apply(args, runtime, { machine, settings, plan, launcher: launcherThere ? 'remove' : undefined }, 'teamrig is not the status line');
}
async function apply(args, runtime, change, unchanged) {
    const { machine, plan } = change;
    const next = plan.settings;
    if (next === undefined && change.launcher === undefined) {
        runtime.out.stdout(`UNCHANGED ${machine.settingsPath}: ${unchanged}`);
        return EXIT.ok;
    }
    const steps = [
        ...(change.launcher === 'write' ? [`  WRITE ${machine.launcher}`] : []),
        ...(next === undefined ? [] : [`  CHANGE ${machine.settingsPath} ${STATUS_LINE_KEY}.command: ${shown(plan.before)} -> ${shown(plan.after)}`]),
        ...(change.launcher === 'remove' ? [`  REMOVE ${machine.launcher}`] : []),
    ];
    if (!args.switches.has('yes')) {
        runtime.out.stdout('PREVIEW nothing written (add --yes to write)');
        steps.forEach((line) => runtime.out.stdout(line));
        return EXIT.ok;
    }
    if (change.launcher === 'write') {
        await runtime.files.write(machine.launcher, LAUNCHER_SCRIPT);
    }
    const backup = next === undefined ? undefined : await writeSettings(runtime, machine, change.settings, next);
    if (change.launcher === 'remove') {
        await runtime.files.remove(machine.launcher);
    }
    runtime.out.stdout(`WROTE the changes below${backup === undefined ? '' : `; the old settings file is at ${backup}`}`);
    steps.forEach((line) => runtime.out.stdout(line));
    return EXIT.ok;
}
function machineOf(runtime) {
    const kitHome = resolveKitHome(runtime.env, runtime.userHome);
    return {
        settingsPath: join(claudeConfigDir(runtime.env, runtime.userHome), 'settings.json'),
        launcher: launcherPath(kitHome),
        backupsDir: join(kitHome, 'backups'),
    };
}
/** Claude Code's user settings; a missing file reads as empty, one that is not a JSON object is refused. */
async function readSettings(runtime, path) {
    const text = await runtime.files.read(path);
    if (text === undefined) {
        return { json: {}, exists: false };
    }
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (error) {
        throw new RefusedError(`${path} is not valid JSON (${errorMessage(error)}); nothing written`);
    }
    if (!isRecord(raw)) {
        throw new RefusedError(`${path} is not a JSON object; nothing written`);
    }
    return { json: raw, exists: true };
}
/** Writes the settings, keeping the old file first when there was one; returns where it was kept. */
async function writeSettings(runtime, machine, settings, next) {
    if (!settings.exists) {
        await runtime.files.write(machine.settingsPath, formatConfig(next));
        return undefined;
    }
    const target = { configPath: machine.settingsPath, backupsDir: machine.backupsDir, backupName: SETTINGS_BACKUP_NAME };
    return writeConfigWithBackup(runtime.files, target, next, runtime.clock);
}
function checked(result) {
    if (!result.ok) {
        throw new RefusedError(result.problem);
    }
    return result.value;
}
function shown(command) {
    return command ?? '(none)';
}
