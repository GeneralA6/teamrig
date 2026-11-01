import { win32 } from 'node:path';
import { powerShellRequest } from "../core/powershell.js";
import { powerShellOutput } from "./powershell-output.js";
/** The current user's Run key: Windows runs the command of each of its values at logon. */
export const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
/** The Run value that starts the restore's check. */
export const RESTORE_RUN_VALUE = 'TeamrigSessionRestore';
export const LOGON_QUERY_TIMEOUT_MS = 30_000;
/** The PowerShell lines every Run key script starts with: stop at the first error, on the key. */
const RUN_KEY_PRELUDE = `$ErrorActionPreference = 'Stop'
$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
$name = '${RESTORE_RUN_VALUE}'
`;
/** Prints the value's command as UTF-8 base64, so no console code page can change a character; nothing when there is none. */
export const WINDOWS_READ_SCRIPT = `${RUN_KEY_PRELUDE}$command = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).$name
if ($null -ne $command) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$command)) }
`;
/** Sets the value to the command, carried as UTF-8 base64 so it needs no quoting inside the script. */
export function windowsWriteScript(command) {
    const encoded = Buffer.from(command, 'utf8').toString('base64');
    return `${RUN_KEY_PRELUDE}$command = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
New-ItemProperty -LiteralPath $key -Name $name -Value $command -PropertyType String -Force | Out-Null
`;
}
export const WINDOWS_REMOVE_SCRIPT = `${RUN_KEY_PRELUDE}if ($null -ne (Get-ItemProperty -LiteralPath $key -Name $name -ErrorAction SilentlyContinue)) {
  Remove-ItemProperty -LiteralPath $key -Name $name
}
`;
/**
 * The system's logon entry for the restore. Only Windows has one so far: a value in the user's Run key, whose
 * command runs Node through `conhost --headless`, so no console window opens at logon. Elsewhere it is undefined.
 */
export function systemLogonEntry(platform, systemRoot, run) {
    return platform === 'win32' ? windowsRunValue(systemRoot ?? 'C:\\Windows', run) : undefined;
}
function windowsRunValue(systemRoot, run) {
    const conhost = win32.join(systemRoot, 'System32', 'conhost.exe');
    return {
        where: `${WINDOWS_RUN_KEY} ${RESTORE_RUN_VALUE}`,
        commandFor: (node, script) => `"${conhost}" --headless "${node}" "${script}"`,
        async read() {
            const printed = powerShellOutput(await run(powerShellRequest(WINDOWS_READ_SCRIPT))).trim();
            return printed === '' ? undefined : Buffer.from(printed, 'base64').toString('utf8');
        },
        async write(command) {
            powerShellOutput(await run(powerShellRequest(windowsWriteScript(command))));
        },
        async remove() {
            powerShellOutput(await run(powerShellRequest(WINDOWS_REMOVE_SCRIPT)));
        },
    };
}
