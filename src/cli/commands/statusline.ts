import { resolveKitHome } from '../../core/home.ts';
import { KIT_VERSION } from '../../core/version.ts';
import type { MachineStep } from '../../restore/install-plan.ts';
import { lowerRecordSteps } from '../../restore/launcher-refresh.ts';
import { planInstall, planUninstall, STATUS_LINE_KEY, type StatusLinePlan } from '../../statusline/install.ts';
import { LAUNCHER_SCRIPT, launcherPath } from '../../statusline/launcher.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { checked, readClaudeSettings, settingsTargetOf, writeClaudeSettings, type ClaudeSettings, type SettingsTarget } from '../claude-settings.ts';
import { underRecordLock } from '../launcher-record-lock.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';

/**
 * `statusline install` and `statusline uninstall`: make `teamrig statusline` Claude Code's status line, or
 * take it back out. They change the person's own Claude Code settings on this machine, not a team's, so
 * any session or person may run them. Without --yes they only show the change; with it, the old settings
 * file is kept in the kit's backups folder first. The launcher is written before the settings name it,
 * and removed only after they stop naming it. The launcher refresh at each session start rewrites the same
 * file (src/restore/launcher-refresh.ts), so with --yes both take its record lock while they read and write,
 * as `restore install` does, and an install that writes the launcher first lowers a record naming a newer
 * version to its own: an older teamrig on the PATH writes its older text, which the next start of a newer
 * one then writes back.
 */

interface Machine extends SettingsTarget {
  readonly kitHome: string;
  readonly launcher: string;
}

/** `statusline install [--yes]`. */
export async function install(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
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
export async function uninstall(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const machine = machineOf(runtime);
  return underRecordLock(args, runtime, machine.kitHome, async () => {
    const settings = await readClaudeSettings(runtime, machine.settingsPath);
    const plan = checked(planUninstall(settings.json, machine.launcher));
    const launcherThere = (await runtime.files.read(machine.launcher)) !== undefined;
    return apply(args, runtime, { machine, settings, plan, lower: [], launcher: launcherThere ? 'remove' : undefined }, 'teamrig is not the status line');
  });
}

interface Change {
  readonly machine: Machine;
  readonly settings: ClaudeSettings;
  readonly plan: StatusLinePlan;
  /** The launcher record's lowering, taken before anything else is written. */
  readonly lower: readonly MachineStep[];
  readonly launcher: 'write' | 'remove' | undefined;
}

async function apply(args: ParsedArgs, runtime: CliRuntime, change: Change, unchanged: string): Promise<ExitCode> {
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

function machineOf(runtime: CliRuntime): Machine {
  const kitHome = resolveKitHome(runtime.env, runtime.userHome);
  return { ...settingsTargetOf(runtime), kitHome, launcher: launcherPath(kitHome) };
}

function shown(command: string | undefined): string {
  return command ?? '(none)';
}
