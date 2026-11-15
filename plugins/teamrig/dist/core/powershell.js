/**
 * Windows PowerShell running `script`, with no profile and no prompts. -EncodedCommand takes the script as
 * UTF-16LE base64, so it needs no quoting through the command line and keeps every character it holds.
 */
export function powerShellRequest(script) {
    return {
        program: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    };
}
/**
 * Makes Windows PowerShell write what a script prints as UTF-8. Left alone, its console writes in the OEM code page,
 * where a character such as `§` becomes the control byte 0x15, and JSON holding it no longer parses: one such command
 * line on the host broke every process listing (T2947).
 */
export const UTF8_OUTPUT = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
