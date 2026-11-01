import { isRecord, stringField } from "../core/guards.js";
import { powerShellRequest } from "../core/powershell.js";
import { powerShellOutput } from "./powershell-output.js";
/** The file name of the shortcut that runs a restore by hand, in the Start menu and wherever the person copied or pinned it. */
export const RESTORE_SHORTCUT_NAME = 'Restore Claude Sessions.lnk';
export const RESTORE_SHORTCUT_DESCRIPTION = 'Reopen the Claude Code sessions a crash, shutdown or closed window ended (teamrig restore run)';
export const SHORTCUT_QUERY_TIMEOUT_MS = 30_000;
/** The shortcut that runs the run launcher under `node`, starting in the person's home folder. */
export function restoreShortcut(node, runLauncher, userHome) {
    return { target: node, arguments: `"${runLauncher}"`, folder: userHome, description: RESTORE_SHORTCUT_DESCRIPTION };
}
/** Whether two shortcuts start the same thing; the tip is not part of it. */
export function sameStart(a, b) {
    return a.target === b.target && a.arguments === b.arguments && a.folder === b.folder;
}
/** A shortcut as a line of `restore install`: what it runs and where, the program and the folder quoted, as either may hold spaces. */
export function shortcutLine(shortcut) {
    return `"${shortcut.target}" ${shortcut.arguments} (in "${shortcut.folder}")`;
}
/**
 * The shortcuts to make start `wanted`: the Start-menu one when it is missing or starts something else, then each
 * other one found by its name that starts something else, such as a taskbar pin made from an older shortcut.
 */
export function shortcutsToWrite(scan, wanted) {
    const startMenu = scan.found.find((found) => found.path === scan.startMenu);
    const others = scan.found.filter((found) => found.path !== scan.startMenu && !sameStart(found, wanted));
    return [
        ...(startMenu !== undefined && sameStart(startMenu, wanted) ? [] : [{ path: scan.startMenu, before: startMenu }]),
        ...others.map((found) => ({ path: found.path, before: found })),
    ];
}
/** The shortcuts found that run the run launcher, which `restore uninstall` removes; one that runs anything else stays. */
export function shortcutsToRemove(scan, runLauncher) {
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
function carried(text) {
    return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text, 'utf8').toString('base64')}'))`;
}
/** Writes the shortcut at `path` through WScript.Shell, which opens the one there to change it, or makes a new one. */
export function windowsWriteShortcutScript(path, shortcut) {
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
export function windowsRemoveShortcutScript(path) {
    return `$ErrorActionPreference = 'Stop'
$path = ${carried(path)}
if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
`;
}
function foundShortcutOf(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const [path, target, args, folder, description] = ['path', 'target', 'arguments', 'folder', 'description'].map((key) => stringField(value, key));
    return path === undefined || target === undefined || args === undefined || folder === undefined || description === undefined
        ? undefined
        : { path, target, arguments: args, folder, description };
}
function scanOf(record) {
    const startMenu = stringField(record, 'startMenu');
    const listed = record['found'];
    if (startMenu === undefined || !Array.isArray(listed)) {
        return undefined;
    }
    const found = listed.map(foundShortcutOf).filter((shortcut) => shortcut !== undefined);
    return found.length === listed.length ? { startMenu, found } : undefined;
}
/** The scan WINDOWS_SCAN_SCRIPT printed; throws when it printed anything else. */
export function parseShortcutScan(printed) {
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(printed.trim(), 'base64').toString('utf8'));
    }
    catch {
        parsed = undefined;
    }
    const scan = isRecord(parsed) ? scanOf(parsed) : undefined;
    if (scan === undefined) {
        throw new Error(`the shortcut scan printed no list of shortcuts: ${printed.trim().slice(0, 80)}`);
    }
    return scan;
}
/** The system's shortcuts a restore by hand starts from. Only Windows has them so far: elsewhere it is undefined. */
export function systemShortcutPlace(platform, run) {
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
