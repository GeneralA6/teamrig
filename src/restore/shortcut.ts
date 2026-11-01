import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { powerShellRequest } from '../core/powershell.ts';
import type { ProgramRunner } from '../github/credentials.ts';
import { powerShellOutput } from './powershell-output.ts';

/** The file name of the shortcut that runs a restore by hand, in the Start menu and wherever the person copied or pinned it. */
export const RESTORE_SHORTCUT_NAME = 'Restore Claude Sessions.lnk';
export const RESTORE_SHORTCUT_DESCRIPTION = 'Reopen the Claude Code sessions a crash, shutdown or closed window ended (teamrig restore run)';
export const SHORTCUT_QUERY_TIMEOUT_MS = 30_000;

/** What a shortcut starts: a program, its arguments as one command-line text, the folder it starts in, and its tip. */
export interface Shortcut {
  readonly target: string;
  readonly arguments: string;
  readonly folder: string;
  readonly description: string;
}

export interface FoundShortcut extends Shortcut {
  readonly path: string;
}

/** The restore shortcuts on this system. */
export interface ShortcutScan {
  /** Where the Start-menu shortcut is, or goes when it is not there. */
  readonly startMenu: string;
  /** Each shortcut named RESTORE_SHORTCUT_NAME in the Start menu, on the desktop or pinned to the taskbar. */
  readonly found: readonly FoundShortcut[];
}

/** The shortcuts of the system a restore by hand starts from. */
export interface ShortcutPlace {
  scan(): Promise<ShortcutScan>;
  /** Makes the shortcut at `path` start `shortcut`: a new one, or the one there changed in place, so a pin stays pinned. */
  write(path: string, shortcut: Shortcut): Promise<void>;
  /** Removes the shortcut at `path`; nothing happens when there is none. */
  remove(path: string): Promise<void>;
}

/** The shortcut that runs the run launcher under `node`, starting in the person's home folder. */
export function restoreShortcut(node: string, runLauncher: string, userHome: string): Shortcut {
  return { target: node, arguments: `"${runLauncher}"`, folder: userHome, description: RESTORE_SHORTCUT_DESCRIPTION };
}

/** Whether two shortcuts start the same thing; the tip is not part of it. */
export function sameStart(a: Shortcut, b: Shortcut): boolean {
  return a.target === b.target && a.arguments === b.arguments && a.folder === b.folder;
}

/** A shortcut as a line of `restore install`: what it runs and where. */
export function shortcutLine(shortcut: Shortcut): string {
  return `"${shortcut.target}" ${shortcut.arguments} (in ${shortcut.folder})`;
}

/** A shortcut `restore install` writes: its path, and what it starts now, undefined when it is not there. */
export interface ShortcutChange {
  readonly path: string;
  readonly before: Shortcut | undefined;
}

/**
 * The shortcuts to make start `wanted`: the Start-menu one when it is missing or starts something else, then each
 * other one found by its name that starts something else, such as a taskbar pin made from an older shortcut.
 */
export function shortcutsToWrite(scan: ShortcutScan, wanted: Shortcut): ShortcutChange[] {
  const startMenu = scan.found.find((found) => found.path === scan.startMenu);
  const others = scan.found.filter((found) => found.path !== scan.startMenu && !sameStart(found, wanted));
  return [
    ...(startMenu !== undefined && sameStart(startMenu, wanted) ? [] : [{ path: scan.startMenu, before: startMenu }]),
    ...others.map((found) => ({ path: found.path, before: found })),
  ];
}

/** The shortcuts found that run the run launcher, which `restore uninstall` removes; one that runs anything else stays. */
export function shortcutsToRemove(scan: ShortcutScan, runLauncher: string): FoundShortcut[] {
  return scan.found.filter((found) => found.arguments.includes(runLauncher));
}

/** The taskbar's pinned shortcuts, under the user's roaming application data folder. */
const TASKBAR_PINS = 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar';

/**
 * Finds the restore shortcuts and prints them, with the Start-menu path, as JSON in UTF-8 base64, so no console code
 * page can change a character of a path.
 */
export const WINDOWS_SCAN_SCRIPT = `$ErrorActionPreference = 'Stop'
$name = '${RESTORE_SHORTCUT_NAME}'
$shell = New-Object -ComObject WScript.Shell
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) $name
$places = @($startMenu, (Join-Path ([Environment]::GetFolderPath('Desktop')) $name), (Join-Path (Join-Path ([Environment]::GetFolderPath('ApplicationData')) '${TASKBAR_PINS}') $name))
$found = @(foreach ($path in $places) {
  if (Test-Path -LiteralPath $path) {
    $link = $shell.CreateShortcut($path)
    [ordered]@{ path = $path; target = $link.TargetPath; arguments = $link.Arguments; folder = $link.WorkingDirectory; description = $link.Description }
  }
})
$json = ConvertTo-Json -Compress -Depth 3 -InputObject ([ordered]@{ startMenu = $startMenu; found = $found })
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
`;

/** Text carried into a script as UTF-8 base64, so it needs no quoting there. */
function carried(text: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text, 'utf8').toString('base64')}'))`;
}

/** Writes the shortcut at `path` through WScript.Shell, which opens the one there to change it, or makes a new one. */
export function windowsWriteShortcutScript(path: string, shortcut: Shortcut): string {
  return `$ErrorActionPreference = 'Stop'
$s = ${carried(JSON.stringify({ path, ...shortcut }))} | ConvertFrom-Json
$link = (New-Object -ComObject WScript.Shell).CreateShortcut($s.path)
$link.TargetPath = $s.target
$link.Arguments = $s.arguments
$link.WorkingDirectory = $s.folder
$link.Description = $s.description
$link.Save()
`;
}

export function windowsRemoveShortcutScript(path: string): string {
  return `$ErrorActionPreference = 'Stop'
$path = ${carried(path)}
if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
`;
}

function foundShortcutOf(value: unknown): FoundShortcut | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const [path, target, args, folder, description] = (['path', 'target', 'arguments', 'folder', 'description'] as const).map((key) => stringField(value, key));
  return path === undefined || target === undefined || args === undefined || folder === undefined || description === undefined
    ? undefined
    : { path, target, arguments: args, folder, description };
}

function scanOf(record: JsonRecord): ShortcutScan | undefined {
  const startMenu = stringField(record, 'startMenu');
  const listed = record['found'];
  if (startMenu === undefined || !Array.isArray(listed)) {
    return undefined;
  }
  const found = listed.map(foundShortcutOf).filter((shortcut): shortcut is FoundShortcut => shortcut !== undefined);
  return found.length === listed.length ? { startMenu, found } : undefined;
}

/** The scan WINDOWS_SCAN_SCRIPT printed; throws when it printed anything else. */
export function parseShortcutScan(printed: string): ShortcutScan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(printed.trim(), 'base64').toString('utf8'));
  } catch {
    parsed = undefined;
  }
  const scan = isRecord(parsed) ? scanOf(parsed) : undefined;
  if (scan === undefined) {
    throw new Error(`the shortcut scan printed no list of shortcuts: ${printed.trim().slice(0, 80)}`);
  }
  return scan;
}

/** The system's shortcuts a restore by hand starts from. Only Windows has them so far: elsewhere it is undefined. */
export function systemShortcutPlace(platform: NodeJS.Platform, run: ProgramRunner): ShortcutPlace | undefined {
  if (platform !== 'win32') {
    return undefined;
  }
  return {
    async scan() {
      return parseShortcutScan(powerShellOutput(await run(powerShellRequest(WINDOWS_SCAN_SCRIPT))));
    },
    async write(path, shortcut) {
      powerShellOutput(await run(powerShellRequest(windowsWriteShortcutScript(path, shortcut))));
    },
    async remove(path) {
      powerShellOutput(await run(powerShellRequest(windowsRemoveShortcutScript(path))));
    },
  };
}
