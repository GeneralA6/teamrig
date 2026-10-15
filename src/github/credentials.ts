import { spawn } from 'node:child_process';
import { errorCode, errorMessage } from '../core/guards.ts';
import { endOf, type ShellEnd } from '../test-run/shell.ts';

/** A credential's name: letters, digits, `.`, `_` or `-`, so it never needs quoting on any command line. */
export const CREDENTIAL_NAME = /^[\w.-]{1,128}$/;

/** A token is printable ASCII with no spaces; anything else was saved some other way. */
const TOKEN_TEXT = /^[\x21-\x7e]+$/;

/** How long a store's tool may take to answer: a local read takes well under a second. */
export const CREDENTIAL_TIMEOUT_MS = 30_000;

/** What reading one credential found. The secret is only ever handed on, never printed. */
export type CredentialRead =
  | { readonly kind: 'found'; readonly secret: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly reason: string };

/** The operating system's store of saved secrets, read by name. teamrig never writes to it. */
export interface CredentialStore {
  /** The store as a message names it, e.g. "the Windows Credential Manager". */
  readonly label: string;
  /** The command a person runs to save a secret under `name`: it asks for the secret and shows nothing typed. */
  saveCommand(name: string): string;
  read(name: string): Promise<CredentialRead>;
}

/** One run of a store's command-line tool: the program and its arguments, passed as a list and never read by a shell. */
export interface ProgramRequest {
  readonly program: string;
  readonly args: readonly string[];
}

export interface ProgramResult {
  readonly end: ShellEnd;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a program to its end with no stdin. It rejects when the program cannot start, such as when it is not installed. */
export type ProgramRunner = (request: ProgramRequest) => Promise<ProgramResult>;

/** One operating system's store: the tool that reads it, and how that tool says "no such credential". */
interface StoreTool {
  readonly label: string;
  /** The program, for a message when it cannot start. */
  readonly program: string;
  saveCommand(name: string): string;
  request(name: string): ProgramRequest;
  missing(result: ProgramResult): boolean;
  secretOf(stdout: string): string;
}

/** The exit code the Windows script ends with when the credential does not exist. */
const WINDOWS_MISSING_EXIT = 3;

/**
 * Reads a generic credential through CredReadW. The secret leaves PowerShell as base64 on stdout, never in
 * argv, which other processes can read. cmdkey saves the blob as UTF-16LE and CredentialBlobSize counts bytes.
 */
export function windowsReadScript(name: string): string {
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace TeamrigCredentials {
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
$secret = [TeamrigCredentials.Cred]::Read('${name}')
if ($null -eq $secret) { exit ${WINDOWS_MISSING_EXIT} }
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($secret)))
`;
}

const WINDOWS: StoreTool = {
  label: 'the Windows Credential Manager',
  program: 'powershell.exe',
  saveCommand: (name) => `cmdkey /generic:${name} /user:teamrig /pass`,
  // -EncodedCommand takes UTF-16LE base64, so the script needs no quoting through the command line.
  request: (name) => ({
    program: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsReadScript(name), 'utf16le').toString('base64')],
  }),
  missing: (result) => result.end.kind === 'exited' && result.end.code === WINDOWS_MISSING_EXIT,
  secretOf: (stdout) => Buffer.from(stdout.trim(), 'base64').toString('utf8'),
};

/** `security` exits 44 when the keychain has no such item. */
const MACOS_MISSING_EXIT = 44;

const MACOS: StoreTool = {
  label: 'the macOS keychain',
  program: 'security',
  saveCommand: (name) => `security add-generic-password -U -s ${name} -a teamrig -w`,
  request: (name) => ({ program: 'security', args: ['find-generic-password', '-s', name, '-w'] }),
  missing: (result) => result.end.kind === 'exited' && result.end.code === MACOS_MISSING_EXIT,
  secretOf: (stdout) => stdout.trimEnd(),
};

/** libsecret's `secret-tool` exits 1 and prints nothing when no item matches; an error (no keyring running) prints why. */
const LINUX: StoreTool = {
  label: 'the Secret Service keyring',
  program: 'secret-tool',
  saveCommand: (name) => `secret-tool store --label=${name} service ${name}`,
  request: (name) => ({ program: 'secret-tool', args: ['lookup', 'service', name] }),
  missing: (result) => result.end.kind === 'exited' && result.end.code === 1 && result.stdout === '' && result.stderr.trim() === '',
  secretOf: (stdout) => stdout.trimEnd(),
};

function toolFor(platform: NodeJS.Platform): StoreTool {
  switch (platform) {
    case 'win32':
      return WINDOWS;
    case 'darwin':
      return MACOS;
    default:
      return LINUX;
  }
}

/** The store of the operating system teamrig runs on, read through its own command-line tool. */
export function systemCredentials(platform: NodeJS.Platform, run: ProgramRunner): CredentialStore {
  const tool = toolFor(platform);
  return {
    label: tool.label,
    saveCommand: (name) => tool.saveCommand(name),
    read: (name) => readWith(tool, run, name),
  };
}

async function readWith(tool: StoreTool, run: ProgramRunner, name: string): Promise<CredentialRead> {
  if (!CREDENTIAL_NAME.test(name)) {
    return { kind: 'failed', reason: `${JSON.stringify(name)} is not a credential name: letters, digits, '.', '_' or '-'` };
  }
  let result: ProgramResult;
  try {
    result = await run(tool.request(name));
  } catch (error) {
    // With no tool to save one (Linux without libsecret's secret-tool), no credential can exist.
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'failed', reason: `${tool.program} could not start: ${errorMessage(error)}` };
  }
  if (tool.missing(result)) {
    return { kind: 'missing' };
  }
  if (result.end.kind !== 'exited' || result.end.code !== 0) {
    return { kind: 'failed', reason: `${tool.program} ${endText(result.end)}: ${firstLine(result.stderr)}` };
  }
  const secret = tool.secretOf(result.stdout);
  if (!TOKEN_TEXT.test(secret)) {
    return { kind: 'failed', reason: `credential ${name} does not hold a token: save it again with ${tool.saveCommand(name)}` };
  }
  return { kind: 'found', secret };
}

function endText(end: ShellEnd): string {
  return end.kind === 'exited' ? `exited ${end.code}` : `was stopped (${end.signal})`;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? 'no error text';
}

/** The real runner: `spawn` with no shell, stdin closed, and a time limit. */
export function nodeProgramRunner(timeoutMs = CREDENTIAL_TIMEOUT_MS): ProgramRunner {
  return (request) =>
    new Promise((resolve, reject) => {
      const child = spawn(request.program, [...request.args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, windowsHide: true });
      const stdout: string[] = [];
      const stderr: string[] = [];
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk));
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ end: endOf(code, signal), stdout: stdout.join(''), stderr: stderr.join('') }));
    });
}
