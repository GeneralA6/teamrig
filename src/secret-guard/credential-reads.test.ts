import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runsOf } from '../package-guard/programs.ts';
import type { ShellDialect } from '../push-guard/tokenizer.ts';
import { credentialReadFindings } from './credential-reads.ts';

/** How the guard names each credential read in `line`, read in `dialect`. */
function reads(line: string, dialect: ShellDialect = 'bash'): string[] {
  const runs = runsOf(line, { cwd: 'C:/w', home: 'C:/u', dialect }).programs;
  return credentialReadFindings(line, runs).map((finding) => (finding.kind === 'credential' ? finding.via : finding.kind));
}

describe('credentialReadFindings', () => {
  it('finds each command that reads a key out of the store, wherever its options stand', () => {
    const cases: readonly (readonly [string, string])[] = [
      ["printf 'protocol=https\\nhost=github.com\\n' | git credential fill", 'git credential fill'],
      ['git -C C:/w credential fill < req.txt', 'git credential fill'],
      ['git credential-manager get', 'git credential-<helper> get'],
      ['C:/Git/mingw64/bin/git-credential-manager.exe get', 'git-credential-<helper> get'],
      ['gh auth token', 'gh auth token'],
      ['gh auth token --hostname github.com', 'gh auth token'],
      ['gh auth status -t', 'gh auth status --show-token'],
      ['gh auth status --show-token=true', 'gh auth status --show-token'],
      ['security find-generic-password -s svc -w', 'security find-*-password'],
      ['security find-internet-password -s github.com', 'security find-*-password'],
      ['security dump-keychain -d', 'security find-*-password'],
      ['secret-tool lookup service svc', 'secret-tool lookup'],
      ['secret-tool search --all service svc', 'secret-tool lookup'],
      ['cmdkey /list', 'cmdkey /list'],
      ['cmdkey /list:git:https://github.com', 'cmdkey /list'],
      ['vaultcmd /listcreds:"Windows Credentials"', 'vaultcmd /listcreds'],
      ['keyring get svc user', 'keyring get'],
    ];
    for (const [line, via] of cases) {
      assert.deepEqual(reads(line), [via], line);
    }
    assert.deepEqual(reads('Get-Secret -Name gh', 'powershell'), ['Get-Secret']);
  });

  it('finds a read whose output is captured or sent away, as holding the key is the harm', () => {
    for (const line of ['T=$(gh auth token) && echo ok', 'gh auth token > t.txt', 'gh auth token | wc -c', 'bash -c "gh auth token"']) {
      assert.deepEqual(reads(line), ['gh auth token'], line);
    }
    assert.deepEqual(reads('$t = gh auth token', 'powershell'), ['gh auth token']);
  });

  it('finds a store API or a teamrig credential name anywhere in the line, inline code and PowerShell types too', () => {
    const cases: readonly (readonly [string, string, ShellDialect])[] = [
      ['Add-Type -MemberDefinition "[DllImport(\\"advapi32\\")] public static extern bool CredReadW(...)"', 'CredRead', 'powershell'],
      ['[CredMan]::CredEnumerate($null)', 'CredRead', 'powershell'],
      ['$v = New-Object Windows.Security.Credentials.PasswordVault', 'PasswordVault', 'powershell'],
      ['Get-StoredCredential -Target x', 'Get-StoredCredential', 'powershell'],
      ['python -c "import keyring; keyring.get_password(\'s\', \'u\')"', 'keyring.get_password', 'bash'],
      ["node -e \"require('keytar').findCredentials('s')\"", 'keytar', 'bash'],
      ['cmdkey /generic:teamrig-gh-acme /user:x /pass', 'teamrig-gh-<owner>', 'powershell'],
      ['node read.mjs TEAMRIG-SHIP-GH', 'teamrig-ship-gh', 'bash'],
    ];
    for (const [line, via, dialect] of cases) {
      assert.deepEqual(reads(line, dialect), [via], line);
    }
  });

  it('names each read once, the commands before the texts', () => {
    assert.deepEqual(reads('gh auth token; cmdkey /list; gh auth token; node x.mjs teamrig-ship-gh'), ['gh auth token', 'cmdkey /list', 'teamrig-ship-gh']);
  });

  it('lets the lines that read no key pass: other subcommands, lookalike programs and names', () => {
    for (const line of [
      'git credential approve',
      'git config --get credential.helper',
      'git credential-manager github list',
      'gh auth status',
      'gh auth login --with-token < t.txt',
      'ghx auth token',
      'security list-keychains',
      'secret-tool store --label=x service svc',
      'cmdkey /add:host /user:u',
      'teamrig who --session teamrig-github',
      'grep -rn tokenName src/github',
      'echo Credentials',
    ]) {
      assert.deepEqual(reads(line), [], line);
    }
  });

  it('reads a long line in time in proportion to it', () => {
    const line = `gh ${'auth '.repeat(20_000)}x`;
    const started = performance.now();
    assert.deepEqual(reads(line), []);
    assert.ok(performance.now() - started < 2_000);
  });
});
