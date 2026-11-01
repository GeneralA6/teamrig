import { errorMessage } from '../../core/guards.ts';
import { resolveKitHome } from '../../core/home.ts';
import { RESTORE_CHECK_LAUNCHER_SCRIPT, restoreCheckLauncherPath } from '../../restore/launcher.ts';
import type { LogonEntry } from '../../restore/logon.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';

/**
 * `restore install` and `restore uninstall`: have the system run `teamrig restore check` at each logon of this
 * user, or stop it. They change this machine, not a team, so any session or person may run them. Without --yes
 * they only show the change. The logon entry names a launcher in the kit home's bin folder, which finds the
 * installed plugin each time, so a plugin update needs no new install; the launcher is written before the entry
 * names it, and removed only after the entry is gone.
 */

interface Step {
  /** The change as the person reads it: `WRITE <file>`, `SET <entry>: <before> -> <after>`, `REMOVE ...`. */
  readonly line: string;
  readonly act: () => Promise<void>;
}

interface Machine {
  readonly entry: LogonEntry;
  readonly launcher: string;
}

/** `restore install [--yes]`. */
export async function restoreInstall(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { entry, launcher } = machineOf(runtime, 'set up');
  const command = entry.commandFor(runtime.self.node, launcher);
  const before = await entry.read();
  const launcherStale = (await runtime.files.read(launcher)) !== RESTORE_CHECK_LAUNCHER_SCRIPT;
  const steps: Step[] = [
    ...(launcherStale ? [{ line: `WRITE ${launcher}`, act: () => runtime.files.write(launcher, RESTORE_CHECK_LAUNCHER_SCRIPT) }] : []),
    ...(before === command ? [] : [{ line: `SET ${entry.where}: ${before ?? '(none)'} -> ${command}`, act: () => entry.write(command) }]),
  ];
  return apply(args, runtime, steps, `${entry.where}: the restore check already runs at logon`);
}

/** `restore uninstall [--yes]`. */
export async function restoreUninstall(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { entry, launcher } = machineOf(runtime, 'take out');
  const before = await entry.read();
  const launcherThere = (await runtime.files.read(launcher)) !== undefined;
  const steps: Step[] = [
    ...(before === undefined ? [] : [{ line: `REMOVE ${entry.where}: ${before}`, act: () => entry.remove() }]),
    ...(launcherThere
      ? [
          {
            line: `REMOVE ${launcher}`,
            act: async () => {
              await runtime.files.remove(launcher);
            },
          },
        ]
      : []),
  ];
  return apply(args, runtime, steps, `${entry.where}: the restore check does not run at logon`);
}

/** Shows the steps, or with --yes takes them in order; at the first that fails, says which and what was done before it. */
async function apply(args: ParsedArgs, runtime: CliRuntime, steps: readonly Step[], unchanged: string): Promise<ExitCode> {
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

/** The system's logon entry and the launcher it names; refused on a system with no logon entry teamrig can set. */
function machineOf(runtime: CliRuntime, verb: string): Machine {
  const entry = runtime.restore.logon;
  if (entry === undefined) {
    throw new RefusedError(`teamrig can ${verb} the logon check on Windows only so far, not on ${runtime.platform}; after a crash or reboot, run teamrig restore run`);
  }
  return { entry, launcher: restoreCheckLauncherPath(resolveKitHome(runtime.env, runtime.userHome)) };
}
