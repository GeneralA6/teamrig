import type { Files } from '../core/files.ts';
import { RESTORE_CHECK_LAUNCHER_SCRIPT, RESTORE_RUN_LAUNCHER_SCRIPT, restoreCheckLauncherPath, restoreRunLauncherPath } from './launcher.ts';
import type { LogonEntry } from './logon.ts';
import { restoreShortcut, shortcutLine, shortcutsToWrite, type ShortcutPlace } from './shortcut.ts';

/**
 * What `teamrig restore install` changes on this machine, and what the launcher refresh at each session start
 * (launcher-refresh.ts) brings up to date after a plugin update: the two launchers, the logon entry that runs the check
 * launcher, and the shortcuts that run the run launcher. Install sets up each part that is missing or out of date.
 * A refresh only rewrites what an install left there: a launcher whose text is older, the logon entry when it is set
 * and the check launcher is there, the shortcuts found when the run launcher is there; it never creates one, so a
 * machine that never ran install, or ran uninstall, stays as it is.
 */

/** One change to the machine. */
export interface MachineStep {
  /** The change as the person reads it: `WRITE <file>` or `SET <place>: <before> -> <after>`. */
  readonly line: string;
  readonly act: () => Promise<void>;
}

/** A launcher file: where it goes and the text it holds. */
export interface Launcher {
  readonly path: string;
  readonly text: string;
}

/** `install` sets up what is missing or out of date; `refresh` changes only what is there and out of date. */
export type PlanMode = 'install' | 'refresh';

/** The parts of the machine a restore install sets up, and what the logon entry and shortcuts run. */
export interface RestoreMachine {
  readonly files: Files;
  readonly kitHome: string;
  /** The Node program the logon entry and the shortcuts start the launchers with. */
  readonly node: string;
  /** The folder the shortcuts start in. */
  readonly userHome: string;
  /** The system's logon entry; undefined on a system with none teamrig can set. */
  readonly logon: LogonEntry | undefined;
  /** The system's restore shortcuts; undefined on a system with none. */
  readonly shortcuts: ShortcutPlace | undefined;
}

export interface MachinePlan {
  /** The changes, in the order to take them: launchers before anything that names them. */
  readonly steps: readonly MachineStep[];
  /** Each part that is up to date, as install says it when there is no step. */
  readonly unchanged: readonly string[];
}

/** The restore's two launchers under the kit home. */
export function restoreLaunchers(kitHome: string): { readonly check: Launcher; readonly run: Launcher } {
  return {
    check: { path: restoreCheckLauncherPath(kitHome), text: RESTORE_CHECK_LAUNCHER_SCRIPT },
    run: { path: restoreRunLauncherPath(kitHome), text: RESTORE_RUN_LAUNCHER_SCRIPT },
  };
}

/** The step that writes `launcher` over `there` (the text the file holds now, undefined for none), when `mode` calls for one. */
function launcherWrite(files: Files, launcher: Launcher, there: string | undefined, mode: PlanMode): MachineStep[] {
  const due = there !== launcher.text && (mode === 'install' || there !== undefined);
  return due ? [{ line: `WRITE ${launcher.path}`, act: () => files.write(launcher.path, launcher.text) }] : [];
}

/** The step that writes `launcher` when `mode` calls for one, reading the file first. */
export async function launcherStep(files: Files, launcher: Launcher, mode: PlanMode): Promise<MachineStep[]> {
  return launcherWrite(files, launcher, await files.read(launcher.path), mode);
}

/** The changes that bring the machine's restore parts up to date in `mode`; it reads the machine, and changes nothing. */
export async function restorePlan(machine: RestoreMachine, mode: PlanMode): Promise<MachinePlan> {
  const { files, logon, shortcuts } = machine;
  const install = mode === 'install';
  const { check, run } = restoreLaunchers(machine.kitHome);
  const [checkThere, runThere] = [await files.read(check.path), await files.read(run.path)];
  const steps = [...launcherWrite(files, check, checkThere, mode), ...launcherWrite(files, run, runThere, mode)];
  const unchanged: string[] = [];
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
