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
