import { errorMessage } from '../../core/guards.ts';
import { resolveKitHome } from '../../core/home.ts';
import { restoreLaunchers, restorePlan, type MachineStep, type RestoreMachine } from '../../restore/install-plan.ts';
import type { LogonEntry } from '../../restore/logon.ts';
import { RESTORE_SHORTCUT_NAME, shortcutLine, shortcutsToRemove } from '../../restore/shortcut.ts';
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
 * name that runs anything else stays. What install changes is src/restore/install-plan.ts, which the launcher refresh
 * at each session start shares.
 */

/** A machine with a logon entry teamrig can set, which install and uninstall need. */
interface LogonMachine extends RestoreMachine {
  readonly logon: LogonEntry;
}

/** `restore install [--yes]`. */
export async function restoreInstall(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { steps, unchanged } = await restorePlan(machineOf(runtime, 'set up'), 'install');
  return apply(args, runtime, steps, unchanged);
}

/** `restore uninstall [--yes]`. */
export async function restoreUninstall(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { logon, shortcuts, kitHome } = machineOf(runtime, 'take out');
  const { check, run } = restoreLaunchers(kitHome);
  const before = await logon.read();
  const steps: MachineStep[] = before === undefined ? [] : [{ line: `REMOVE ${logon.where}: ${before}`, act: () => logon.remove() }];
  const unchanged = [`${logon.where}: the restore check does not run at logon`];
  if (shortcuts !== undefined) {
    for (const found of shortcutsToRemove(await shortcuts.scan(), run.path)) {
      steps.push({ line: `REMOVE ${found.path}: ${shortcutLine(found)}`, act: () => shortcuts.remove(found.path) });
    }
    unchanged.push(`no ${RESTORE_SHORTCUT_NAME} runs ${run.path}`);
  }
  steps.push(...(await removeIfThere(runtime, check.path)), ...(await removeIfThere(runtime, run.path)));
  return apply(args, runtime, steps, unchanged);
}

/** The step that removes the file at `path`, none when there is none. */
async function removeIfThere(runtime: CliRuntime, path: string): Promise<MachineStep[]> {
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
async function apply(args: ParsedArgs, runtime: CliRuntime, steps: readonly MachineStep[], unchanged: readonly string[]): Promise<ExitCode> {
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

/** The machine's restore parts, run by this CLI's Node; refused on a system with no logon entry teamrig can set. */
function machineOf(runtime: CliRuntime, verb: string): LogonMachine {
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
