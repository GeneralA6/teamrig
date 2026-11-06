import type { Files } from '../core/files.ts';
import { RESTORE_CHECK_LAUNCHER_SCRIPT, RESTORE_RUN_LAUNCHER_SCRIPT, restoreCheckLauncherPath, restoreRunLauncherPath } from './launcher.ts';
import type { FoundPart, LauncherSurvey, RegisteredPart } from './launcher-survey.ts';
import type { LogonEntry } from './logon.ts';
import { restoreShortcut, sameStart, shortcutLine, shortcutsToWrite, type FoundShortcut, type Shortcut, type ShortcutPlace } from './shortcut.ts';

/**
 * What `teamrig restore install` changes on this machine, and what the launcher refresh at each session start
 * (launcher-refresh.ts) brings up to date after a plugin update: the two launchers, the logon entry that runs the check
 * launcher, and the shortcuts that run the run launcher. Install sets up each part that is missing or out of date.
 * A refresh only rewrites what an install left there: a launcher whose text is older, the logon entry when it is set
 * and the check launcher is there, the shortcuts found when the run launcher is there; it never creates one, so a
 * machine that never ran install, or ran uninstall, stays as it is. Both read the logon entry and the shortcuts even
 * where they change nothing, for the plan's `after`: what starts the restore once the steps are taken, which the
 * launcher record keeps for `teamrig check` (launcher-survey.ts).
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
  /** What starts the restore once the steps are taken. */
  readonly after: LauncherSurvey;
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

/**
 * What a plan does to the logon entry or the shortcuts: `create` sets each up that is missing or out of date (install),
 * `repoint` changes only one there that is out of date (a refresh with its launcher there), `leave` reads them only (a
 * refresh with its launcher missing, which an uninstall took out or no install wrote).
 */
type PartAction = 'create' | 'repoint' | 'leave';

function partAction(mode: PlanMode, launcherThere: boolean): PartAction {
  if (mode === 'install') {
    return 'create';
  }
  return launcherThere ? 'repoint' : 'leave';
}

/** The plan for the logon entry or the shortcuts. */
interface PartPlan {
  readonly steps: readonly MachineStep[];
  readonly unchanged: readonly string[];
  readonly after: LauncherSurvey;
}

/** The logon entry's plan: it runs the check launcher under `node`. */
async function logonPlan(logon: LogonEntry, node: string, check: Launcher, action: PartAction): Promise<PartPlan> {
  const command = logon.commandFor(node, check.path);
  const before = await logon.read();
  const writes = action !== 'leave' && before !== command && (action === 'create' || before !== undefined);
  const now = writes ? command : before;
  const registered: RegisteredPart[] = now === command ? [{ kind: 'logon', where: logon.where, program: node, script: check.path }] : [];
  const found: FoundPart[] = now === undefined || now === command ? [] : [{ kind: 'logon', where: logon.where, runs: now }];
  return {
    steps: writes ? [{ line: `SET ${logon.where}: ${before ?? '(none)'} -> ${command}`, act: () => logon.write(command) }] : [],
    unchanged: action === 'leave' ? [] : [`${logon.where}: the restore check already runs at logon`],
    after: { registered, found },
  };
}

/** The shortcuts' plan: each is to start `wanted`, which runs the run launcher at `runLauncher`. */
async function shortcutPlan(shortcuts: ShortcutPlace, wanted: Shortcut, runLauncher: string, action: PartAction): Promise<PartPlan> {
  const scan = await shortcuts.scan();
  const writes = action === 'leave' ? [] : shortcutsToWrite(scan, wanted).filter((change) => action === 'create' || change.before !== undefined);
  const written = new Set(writes.map((change) => change.path));
  const created = written.has(scan.startMenu) && !scan.found.some((found) => found.path === scan.startMenu);
  const now: FoundShortcut[] = [
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
        .map((shortcut): RegisteredPart => ({ kind: 'shortcut', where: shortcut.path, program: wanted.target, script: runLauncher })),
      found: now.filter((shortcut) => !sameStart(shortcut, wanted)).map((shortcut): FoundPart => ({ kind: 'shortcut', where: shortcut.path, runs: shortcutLine(shortcut) })),
    },
  };
}

/** The changes that bring the machine's restore parts up to date in `mode`; it reads the machine, and changes nothing. */
export async function restorePlan(machine: RestoreMachine, mode: PlanMode): Promise<MachinePlan> {
  const { files, logon, shortcuts } = machine;
  const { check, run } = restoreLaunchers(machine.kitHome);
  const [checkThere, runThere] = [await files.read(check.path), await files.read(run.path)];
  const parts: PartPlan[] = [];
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
