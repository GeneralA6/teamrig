import { errorMessage } from '../../core/guards.ts';
import { resolveKitHome } from '../../core/home.ts';
import { RESTORE_CHECK_LAUNCHER_SCRIPT, RESTORE_RUN_LAUNCHER_SCRIPT, restoreCheckLauncherPath, restoreRunLauncherPath } from '../../restore/launcher.ts';
import type { LogonEntry } from '../../restore/logon.ts';
import {
  RESTORE_SHORTCUT_NAME,
  restoreShortcut,
  shortcutLine,
  shortcutsToRemove,
  shortcutsToWrite,
  type ShortcutPlace,
} from '../../restore/shortcut.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';

/**
 * `restore install` and `restore uninstall`: have the system run `teamrig restore check` at each logon of this
 * user, and give the person the Start-menu shortcut "Restore Claude Sessions" that runs `teamrig restore run` by
 * hand from anywhere; or take both out. They change this machine, not a team, so any session or person may run
 * them. Without --yes they only show the change. The logon entry and the shortcut name launchers in the kit home's
 * bin folder, which find the installed plugin each time, so a plugin update needs no new install. Install writes the
 * launchers before anything names them, then the entry, then the Start-menu shortcut and each other shortcut of that
 * name that starts something else (a taskbar pin made from an older one), changed in place so a pin stays pinned.
 * Uninstall removes the entry and the shortcuts that run the run launcher before the launchers; a shortcut of that
 * name that runs anything else stays.
 */

interface Step {
  /** The change as the person reads it: `WRITE <file>`, `SET <entry>: <before> -> <after>`, `REMOVE ...`. */
  readonly line: string;
  readonly act: () => Promise<void>;
}

interface Machine {
  readonly entry: LogonEntry;
  readonly shortcuts: ShortcutPlace | undefined;
  readonly checkLauncher: string;
  readonly runLauncher: string;
}

/** `restore install [--yes]`. */
export async function restoreInstall(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { entry, shortcuts, checkLauncher, runLauncher } = machineOf(runtime, 'set up');
  const command = entry.commandFor(runtime.self.node, checkLauncher);
  const before = await entry.read();
  const steps: Step[] = [
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
export async function restoreUninstall(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { entry, shortcuts, checkLauncher, runLauncher } = machineOf(runtime, 'take out');
  const before = await entry.read();
  const steps: Step[] = before === undefined ? [] : [{ line: `REMOVE ${entry.where}: ${before}`, act: () => entry.remove() }];
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
async function writeUnlessThere(runtime: CliRuntime, path: string, text: string): Promise<Step[]> {
  return (await runtime.files.read(path)) === text ? [] : [{ line: `WRITE ${path}`, act: () => runtime.files.write(path, text) }];
}

/** The step that removes the file at `path`, none when there is none. */
async function removeIfThere(runtime: CliRuntime, path: string): Promise<Step[]> {
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
async function apply(args: ParsedArgs, runtime: CliRuntime, steps: readonly Step[], unchanged: readonly string[]): Promise<ExitCode> {
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
    } catch (error) {
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
function machineOf(runtime: CliRuntime, verb: string): Machine {
  const entry = runtime.restore.logon;
  if (entry === undefined) {
    throw new RefusedError(`teamrig can ${verb} the logon check on Windows only so far, not on ${runtime.platform}; after a crash or reboot, run teamrig restore run`);
  }
  const kitHome = resolveKitHome(runtime.env, runtime.userHome);
  return { entry, shortcuts: runtime.restore.shortcuts, checkLauncher: restoreCheckLauncherPath(kitHome), runLauncher: restoreRunLauncherPath(kitHome) };
}
