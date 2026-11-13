import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mock, test } from 'node:test';
import { NOT_FOUND_EXIT, type PowerShell, credentialScript, readCredential, windowsPowerShell } from './keychain.ts';

const TOKEN = ['github', '_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'].join('');
const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

test('the script reads the named target and exits with the not-found code when it is absent', () => {
  const script = credentialScript('teamrig-ship-gh');
  assert.match(script, /\[TeamrigShip\.Cred\]::Read\('teamrig-ship-gh'\)/);
  assert.match(script, new RegExp(`exit ${NOT_FOUND_EXIT}`));
  assert.match(script, /PtrToStringUni\(credential\.CredentialBlob, credential\.CredentialBlobSize \/ 2\)/);
});

test('a target that could break out of the script is refused before PowerShell runs', () => {
  assert.throws(() => credentialScript("x'); Remove-Item C:\\ -Recurse; ('"), /must be letters, digits/);
  assert.throws(() => credentialScript(''), /must be letters, digits/);
});

test('decodes the secret from base64 stdout', () => {
  const powershell = mock.fn<PowerShell>(() => ({ status: 0, stdout: `${base64(TOKEN)}\r\n`, stderr: '' }));
  assert.deepEqual(readCredential('teamrig-ship-gh', powershell), { kind: 'found', secret: TOKEN });
  assert.equal(powershell.mock.callCount(), 1);
});

test('a missing credential is reported as missing, not as an error', () => {
  assert.deepEqual(readCredential('teamrig-ship-gh', () => ({ status: NOT_FOUND_EXIT, stdout: '', stderr: '' })), { kind: 'missing' });
});

test('a failed PowerShell run gives its first error line', () => {
  const failed = readCredential('teamrig-ship-gh', () => ({ status: 1, stdout: '', stderr: '\r\nAdd-Type : Cannot add type.\r\nAt line:2' }));
  assert.deepEqual(failed, { kind: 'error', reason: 'powershell exited 1: Add-Type : Cannot add type.' });
  const killed = readCredential('teamrig-ship-gh', () => ({ status: null, stdout: '', stderr: '' }));
  assert.deepEqual(killed, { kind: 'error', reason: 'powershell exited by a signal: no error text' });
});

test('a blob that is not a printable token (stored in another encoding) is refused without echoing it', () => {
  const garbled = Buffer.from('QZXV\u0000QZXW', 'utf8').toString('base64');
  const result = readCredential('teamrig-ship-gh', () => ({ status: 0, stdout: garbled, stderr: '' }));
  assert.equal(result.kind, 'error');
  assert.doesNotMatch(JSON.stringify(result), /QZX/);
});

test('the real PowerShell runner reports a script\'s exit, and a failed start where there is no powershell.exe', () => {
  const result = windowsPowerShell('exit 3');
  // On Windows the script's own exit code; elsewhere powershell.exe is not found, so the run has no status. Either
  // way the runner returns a spawn result rather than throwing, which readCredential reads as an error.
  assert.equal(result.status, process.platform === 'win32' ? 3 : null);
  assert.equal(typeof result.stdout, 'string');
  assert.equal(typeof result.stderr, 'string');
});

// The keychain reads Windows Credential Manager only, and the repo gate fails a skipped test, so other hosts do not register it.
if (process.platform === 'win32') test('reads a real generic credential from Windows Credential Manager', () => {
  const target = `teamrig-ship-test-${randomBytes(4).toString('hex')}`;
  const secret = `test_${randomBytes(12).toString('hex')}`;
  const stored = spawnSync('cmdkey', [`/generic:${target}`, '/user:teamrig-test', `/pass:${secret}`], { encoding: 'utf8', windowsHide: true });
  assert.equal(stored.status, 0, stored.stdout);
  try {
    assert.deepEqual(readCredential(target, windowsPowerShell), { kind: 'found', secret });
  } finally {
    spawnSync('cmdkey', [`/delete:${target}`], { windowsHide: true });
  }
  assert.deepEqual(readCredential(target, windowsPowerShell), { kind: 'missing' });
});
