import { join } from 'node:path';
const HISTORY_FILE = 'ConsoleHost_history.txt';
const PROFILE_FOLDERS = ['PowerShell', 'WindowsPowerShell'];
const PROFILE_FILES = ['Microsoft.PowerShell_profile.ps1', 'profile.ps1'];
/** A variable's value, trimmed; undefined when it is unset or blank. */
function envPath(env, name) {
    const value = env[name]?.trim();
    return value === undefined || value === '' ? undefined : value;
}
/**
 * The file PSReadLine saves each line typed in the PowerShell console to: on Windows under `%APPDATA%`, else under
 * `$XDG_DATA_HOME` (default `~/.local/share`). Windows PowerShell and PowerShell 7 share it.
 */
export function psReadLineHistory({ env, userHome, platform }) {
    if (platform === 'win32') {
        const appData = envPath(env, 'APPDATA') ?? join(userHome, 'AppData', 'Roaming');
        return join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', HISTORY_FILE);
    }
    const data = envPath(env, 'XDG_DATA_HOME') ?? join(userHome, '.local', 'share');
    return join(data, 'powershell', 'PSReadLine', HISTORY_FILE);
}
/**
 * The current user's PowerShell profiles the console loads, for Windows PowerShell and PowerShell 7: on Windows in the
 * Documents folder, which OneDrive often moves under its own folder (`%OneDrive%`, `%OneDriveConsumer%`,
 * `%OneDriveCommercial%`, else `~/OneDrive`), else under `$XDG_CONFIG_HOME` (default `~/.config`).
 */
export function powerShellProfiles({ env, userHome, platform }) {
    if (platform !== 'win32') {
        const config = envPath(env, 'XDG_CONFIG_HOME') ?? join(userHome, '.config');
        return PROFILE_FILES.map((file) => join(config, 'powershell', file));
    }
    const oneDrives = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'].flatMap((name) => envPath(env, name) ?? []);
    const documents = [...new Set([userHome, ...oneDrives, join(userHome, 'OneDrive')].map((folder) => join(folder, 'Documents')))];
    return documents.flatMap((folder) => PROFILE_FOLDERS.flatMap((shell) => PROFILE_FILES.map((file) => join(folder, shell, file))));
}
/** A setting that keeps a typed line out of the history file: a handler that judges each line, or saving turned off. */
const HISTORY_GATE = /\bAddToHistoryHandler\b|\bHistorySaveStyle\b[\s=:\]]*['"]?SaveNothing\b/i;
/**
 * Whether a profile's code sets a history gate, its comments (`#` lines and `<# #>` blocks) left out. Windows
 * PowerShell 5.1's `>` and `Out-File` write UTF-16, read here as UTF-8: dropping its zero bytes leaves the ASCII text
 * the gate is written in.
 */
export function setsHistoryGate(profile) {
    const code = profile
        .replace(/\0/g, '')
        .replace(/<#[\s\S]*?#>/g, '')
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
    return HISTORY_GATE.test(code);
}
/**
 * The user's PowerShell history file, when it exists, and the profiles that exist, with whether one keeps typed lines
 * out of that file. It reads the profiles only: the history file is probed, never read.
 */
export async function readShellHistory(files, probe, home) {
    const path = psReadLineHistory(home);
    const history = (await probe.kind(path)) === 'file' ? path : undefined;
    const read = await Promise.all(powerShellProfiles(home).map(async (profile) => ({ profile, text: await files.read(profile) })));
    const found = read.flatMap(({ profile, text }) => (text === undefined ? [] : [{ profile, text }]));
    return { history, profiles: found.map(({ profile }) => profile), gated: found.some(({ text }) => setsHistoryGate(text)) };
}
