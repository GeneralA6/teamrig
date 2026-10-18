/** One run of Windows PowerShell on a script: the program and its arguments, read by no shell. */
export interface PowerShellRequest {
  readonly program: string;
  readonly args: readonly string[];
}

/**
 * Windows PowerShell running `script`, with no profile and no prompts. -EncodedCommand takes the script as
 * UTF-16LE base64, so it needs no quoting through the command line and keeps every character it holds.
 */
export function powerShellRequest(script: string): PowerShellRequest {
  return {
    program: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}
