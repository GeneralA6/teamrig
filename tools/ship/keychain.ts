import { spawnSync } from 'node:child_process';
import { SHIP_TOKEN } from '../../src/github/tokens.ts';

/**
 * Reads a generic credential's secret from Windows Credential Manager (CredReadW), so ship's gh calls get a
 * token that lives in no file, env profile or log. The secret leaves PowerShell as base64 on stdout (never in
 * argv, which other processes can read) and is decoded here in memory only.
 * Store it once (prompts, nothing echoed): cmdkey /generic:teamrig-ship-gh /user:teamrig /pass
 */
export const SHIP_TOKEN_TARGET = SHIP_TOKEN;

/** PowerShell's exit code when the credential does not exist. */
export const NOT_FOUND_EXIT = 3;

export interface Spawned {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a PowerShell script; injected so tests never touch the real credential store. */
export type PowerShell = (script: string) => Spawned;

export type Credential = { kind: 'found'; secret: string } | { kind: 'missing' } | { kind: 'error'; reason: string };

const TARGET_PATTERN = /^[\w.-]{1,128}$/;
/** A token is printable ASCII with no spaces; anything else is a blob stored in another encoding. */
const SECRET_PATTERN = /^[\x21-\x7e]+$/;

/** cmdkey stores the blob as UTF-16LE; CredentialBlobSize counts bytes. */
export function credentialScript(target: string): string {
  if (!TARGET_PATTERN.test(target)) throw new Error(`credential target ${JSON.stringify(target)} must be letters, digits, '.', '_' or '-'`);
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace TeamrigShip {
  public static class Cred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
      public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
      public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
      public int AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr credential);
    public static string Read(string target) {
      IntPtr pointer;
      if (!CredReadW(target, 1, 0, out pointer)) return null;
      try {
        CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
        return Marshal.PtrToStringUni(credential.CredentialBlob, credential.CredentialBlobSize / 2);
      } finally { CredFree(pointer); }
    }
  }
}
'@
$secret = [TeamrigShip.Cred]::Read('${target}')
if ($null -eq $secret) { exit ${NOT_FOUND_EXIT} }
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($secret)))
`;
}

export function readCredential(target: string, powershell: PowerShell): Credential {
  const result = powershell(credentialScript(target));
  if (result.status === NOT_FOUND_EXIT) return { kind: 'missing' };
  if (result.status !== 0) {
    const firstLine = result.stderr.split(/\r?\n/).find(line => line.trim() !== '') ?? 'no error text';
    return { kind: 'error', reason: `powershell exited ${result.status ?? 'by a signal'}: ${firstLine}` };
  }
  const secret = Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
  if (!SECRET_PATTERN.test(secret)) return { kind: 'error', reason: `the ${target} blob is not a printable token (stored as UTF-8? re-store it with cmdkey)` };
  return { kind: 'found', secret };
}

/** Runs a program to its end; injected so a spec checks PowerShell's command line on any host. */
export type RunProgram = (file: string, args: readonly string[]) => Spawned;

/** Runs `file` with no window; a program that cannot start has a null status and no output. */
export const runProgram: RunProgram = (file, args) => {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

/** -EncodedCommand takes UTF-16LE base64, so the script needs no quoting through the command line. */
export function encodedPowerShell(run: RunProgram): PowerShell {
  return script => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
}

export const windowsPowerShell: PowerShell = encodedPowerShell(runProgram);
