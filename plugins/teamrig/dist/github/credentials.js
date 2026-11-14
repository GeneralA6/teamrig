import { spawn } from 'node:child_process';
import { errorCode, errorMessage } from "../core/guards.js";
import { powerShellRequest } from "../core/powershell.js";
import { endOf } from "../test-run/shell.js";
/** A credential's name: letters, digits, `.`, `_` or `-`, so it never needs quoting on any command line. */
export const CREDENTIAL_NAME = /^[\w.-]{1,128}$/;
/** A token is printable ASCII with no spaces; anything else was saved some other way. */
const TOKEN_TEXT = /^[\x21-\x7e]+$/;
/** How long a store's tool may take to answer: a local read takes well under a second. */
export const CREDENTIAL_TIMEOUT_MS = 30_000;
/**
 * A secret teamrig saves itself: printable ASCII that no store tool's own reader splits or quotes (macOS's
 * `security -i` reads its stdin as words), such as base64url text.
 */
const SAVED_TEXT = /^[A-Za-z0-9._~+/=-]{1,1024}$/;
/**
 * Saves a generic credential through CredWriteW, its blob UTF-16LE as cmdkey saves one (so windowsReadScript reads
 * it back), kept for this user on this machine. The secret comes in on stdin, never in the encoded script.
 */
export function windowsSaveScript(name) {
    return `$ErrorActionPreference = 'Stop'
$secret = [Console]::In.ReadToEnd()
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace TeamrigCredentialSave {
  public static class Cred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
      public int Flags; public int Type; public string TargetName; public string Comment;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
      public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
      public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWriteW(ref CREDENTIAL credential, int flags);
    public static int Save(string target, string secret) {
      byte[] blob = System.Text.Encoding.Unicode.GetBytes(secret);
      IntPtr pointer = Marshal.AllocHGlobal(blob.Length);
      try {
        Marshal.Copy(blob, 0, pointer, blob.Length);
        CREDENTIAL credential = new CREDENTIAL();
        credential.Type = 1; credential.TargetName = target; credential.UserName = "teamrig"; credential.Persist = 2;
        credential.CredentialBlobSize = blob.Length; credential.CredentialBlob = pointer;
        return CredWriteW(ref credential, 0) ? 0 : Marshal.GetLastWin32Error();
      } finally { Marshal.FreeHGlobal(pointer); }
    }
  }
}
'@
$failed = [TeamrigCredentialSave.Cred]::Save('${name}', $secret)
if ($failed -ne 0) { [Console]::Error.Write("CredWriteW failed with Windows error $failed"); exit 1 }
`;
}
/** The exit code the Windows script ends with when the credential does not exist. */
const WINDOWS_MISSING_EXIT = 3;
/**
 * Reads a generic credential through CredReadW. The secret leaves PowerShell as base64 on stdout, never in
 * argv, which other processes can read. cmdkey saves the blob as UTF-16LE and CredentialBlobSize counts bytes.
 */
export function windowsReadScript(name) {
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
const WINDOWS = {
    label: 'the Windows Credential Manager',
    program: 'powershell.exe',
    saveCommand: (name) => `cmdkey /generic:${name} /user:teamrig /pass`,
    request: (name) => powerShellRequest(windowsReadScript(name)),
    missing: (result) => result.end.kind === 'exited' && result.end.code === WINDOWS_MISSING_EXIT,
    secretOf: (stdout) => Buffer.from(stdout.trim(), 'base64').toString('utf8'),
    saveRequest: (name, secret) => ({ ...powerShellRequest(windowsSaveScript(name)), stdin: secret }),
};
/** `security` exits 44 when the keychain has no such item. */
const MACOS_MISSING_EXIT = 44;
const MACOS = {
    label: 'the macOS keychain',
    program: 'security',
    saveCommand: (name) => `security add-generic-password -U -s ${name} -a teamrig -w`,
    request: (name) => ({ program: 'security', args: ['find-generic-password', '-s', name, '-w'] }),
    missing: (result) => result.end.kind === 'exited' && result.end.code === MACOS_MISSING_EXIT,
    secretOf: (stdout) => stdout.trimEnd(),
    // `security -i` reads its commands from stdin, so the secret stays out of argv, which `ps` shows every user.
    saveRequest: (name, secret) => ({ program: 'security', args: ['-i'], stdin: `add-generic-password -U -s ${name} -a teamrig -w ${secret}\n` }),
};
/** libsecret's `secret-tool` exits 1 and prints nothing when no item matches; an error (no keyring running) prints why. */
const LINUX = {
    label: 'the Secret Service keyring',
    program: 'secret-tool',
    saveCommand: (name) => `secret-tool store --label=${name} service ${name}`,
    request: (name) => ({ program: 'secret-tool', args: ['lookup', 'service', name] }),
    missing: (result) => result.end.kind === 'exited' && result.end.code === 1 && result.stdout === '' && result.stderr.trim() === '',
    secretOf: (stdout) => stdout.trimEnd(),
    // `secret-tool store` reads the secret from stdin when stdin is not a terminal.
    saveRequest: (name, secret) => ({ program: 'secret-tool', args: ['store', `--label=${name}`, 'service', name], stdin: secret }),
};
function toolFor(platform) {
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
export function systemCredentials(platform, run) {
    const tool = toolFor(platform);
    return {
        label: tool.label,
        saveCommand: (name) => tool.saveCommand(name),
        read: (name) => readWith(tool, run, name),
        save: (name, secret) => saveWith(tool, run, name, secret),
    };
}
/**
 * Saves through the store's tool, then reads the name back: a tool that ends 0 without saving (macOS's `security -i`
 * does not end with its command's status) still fails here. No reason ever holds the secret.
 */
async function saveWith(tool, run, name, secret) {
    if (!CREDENTIAL_NAME.test(name)) {
        return { kind: 'failed', reason: `${JSON.stringify(name)} is not a credential name: letters, digits, '.', '_' or '-'` };
    }
    if (!SAVED_TEXT.test(secret)) {
        return { kind: 'failed', reason: `the secret for ${name} is not text teamrig saves: letters, digits and . _ ~ + / = -` };
    }
    let result;
    try {
        result = await run(tool.saveRequest(name, secret));
    }
    catch (error) {
        return { kind: 'failed', reason: `${tool.program} could not start: ${errorMessage(error)}` };
    }
    if (result.end.kind !== 'exited' || result.end.code !== 0) {
        return { kind: 'failed', reason: `${tool.program} ${endText(result.end)}: ${firstLine(result.stderr)}` };
    }
    const back = await readWith(tool, run, name);
    if (back.kind === 'found' && back.secret === secret) {
        return { kind: 'saved' };
    }
    const found = back.kind === 'failed' ? back.reason : back.kind === 'missing' ? 'nothing is saved under it' : 'it holds another value';
    return { kind: 'failed', reason: `${tool.label} did not keep ${name}: read back, ${found}` };
}
async function readWith(tool, run, name) {
    if (!CREDENTIAL_NAME.test(name)) {
        return { kind: 'failed', reason: `${JSON.stringify(name)} is not a credential name: letters, digits, '.', '_' or '-'` };
    }
    let result;
    try {
        result = await run(tool.request(name));
    }
    catch (error) {
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
function endText(end) {
    return end.kind === 'exited' ? `exited ${end.code}` : `was stopped (${end.signal})`;
}
function firstLine(text) {
    return text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? 'no error text';
}
/** The real runner: `spawn` with no shell, stdin given the request's text and closed (at once with none), and a time limit. */
export function nodeProgramRunner(timeoutMs = CREDENTIAL_TIMEOUT_MS) {
    return (request) => new Promise((resolve, reject) => {
        const child = spawn(request.program, [...request.args], { stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs, windowsHide: true });
        // A program that ends before reading all of stdin breaks the pipe: its exit, not that error, says how it went.
        child.stdin.on('error', () => undefined);
        child.stdin.end(request.stdin ?? '');
        const stdout = [];
        const stderr = [];
        child.stdout.setEncoding('utf8').on('data', (chunk) => stdout.push(chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk) => stderr.push(chunk));
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ end: endOf(code, signal), stdout: stdout.join(''), stderr: stderr.join('') }));
    });
}
