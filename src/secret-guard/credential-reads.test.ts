import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runsOf } from '../package-guard/programs.ts';
import type { ShellDialect } from '../push-guard/tokenizer.ts';
import { Location } from '../push-guard/location.ts';
import { credentialReadFindings, NO_SEARCH_START, type SearchStart } from './credential-reads.ts';

/** The checkout the lines start in, as the walker resolves it. */
const CHECKOUT = new Location('C:/w', 'C:/u').dir;

/** How the guard names each credential read in `line`, read in `dialect`, started in a work tree unless `start` says. */
function reads(line: string, dialect: ShellDialect = 'bash', start: SearchStart = { dir: CHECKOUT, inWorkTree: () => true }): string[] {
  const runs = runsOf(line, { cwd: 'C:/w', home: 'C:/u', dialect });
  return credentialReadFindings(line, runs, start).map((finding) => (finding.kind === 'credential' ? finding.via : finding.kind));
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

  it('lets a git grep of the repository search for a teamrig credential name, which reads no store (#1469)', () => {
    for (const line of [
      'git grep -n teamrig-gh- -- src',
      'git grep -n -i TEAMRIG-SHIP-GH',
      'git grep -l teamrig-gh- && git grep -c teamrig-ship-gh',
      'git --no-pager grep --cached -e teamrig-gh-',
      'git -P grep -niw -A3 --max-depth=2 --threads 2 -e teamrig-gh- -- src docs',
      'git grep -c --heading teamrig-gh- --and -e -O',
      // A quoted glob reaches git as written, so the guard reads the word git gets.
      "git grep -e 'teamrig-gh-*'",
      'git grep teamrig-gh- -- "*.ts"',
    ]) {
      assert.deepEqual(reads(line), [], line);
    }
  });

  it('names the credential name when the search runs anywhere but the folder the line starts in, which git finds a work tree in', () => {
    const line = 'git grep -n teamrig-gh-';
    for (const moved of [
      `cd C:/x && ${line}`,
      `(cd C:/x; ${line})`,
      `pushd C:/x; ${line}`,
      `cd C:/x; ${line}; cd C:/w`,
      `cd "$X" && ${line}`,
      `${line} && cd C:/x && ${line}`,
      // Any folder or stack move on the line, even one that seems to come back to the start folder.
      `cd C:/w && ${line}`,
      `cd . && ${line}`,
      `pushd C:/x; popd; ${line}`,
      `pushd -n C:/x; popd; ${line}`,
      `pushd -n C:/x; pushd; ${line}`,
      `pushd C:/x; pushd C:/y; popd +1; popd; ${line}`,
      `bash -c 'cd C:/w; ${line}'`,
    ]) {
      assert.deepEqual(reads(moved), ['teamrig-gh-<owner>'], moved);
    }
    for (const moved of [`Push-Location -StackName s C:/x; Pop-Location; ${line}`, `Push-Location C:/x; Pop-Location -StackName s; ${line}`, `Set-Location C:/w; ${line}`]) {
      assert.deepEqual(reads(moved, 'powershell'), ['teamrig-gh-<owner>'], moved);
    }
    assert.deepEqual(reads(line, 'powershell'), [], 'the same search in PowerShell, with no move');
    let asked: string | undefined;
    const outside: SearchStart = { dir: CHECKOUT, inWorkTree: (dir) => ((asked = dir), false) };
    assert.deepEqual(reads(line, 'bash', outside), ['teamrig-gh-<owner>'], 'a start folder outside any work tree');
    assert.equal(asked, CHECKOUT, 'git is asked about the folder the line starts in');
    assert.deepEqual(reads(line, 'bash', NO_SEARCH_START), ['teamrig-gh-<owner>'], 'no start folder known');
    assert.deepEqual(reads(line, 'bash', { dir: undefined, inWorkTree: () => true }), ['teamrig-gh-<owner>'], 'a start folder only known when the line runs');
  });

  it('asks git nothing for a line with no credential name on it', () => {
    const never: SearchStart = { dir: CHECKOUT, inWorkTree: () => assert.fail('git asked') };
    assert.deepEqual(reads('git grep -n token', 'bash', never), []);
    assert.deepEqual(reads('git grep -n keytar', 'bash', never), ['keytar'], 'a store API is named whatever runs');
  });

  it('still names the credential name when anything but a plain git grep of the repository runs on the line', () => {
    const cases: readonly (readonly [string, readonly string[]])[] = [
      ['git grep -n teamrig-gh- | head', ['teamrig-gh-<owner>']],
      ['git grep teamrig-gh-; cmdkey /generic:teamrig-gh-acme /user:x /pass', ['teamrig-gh-<owner>']],
      ['git grep --no-index teamrig-gh- C:/u', ['teamrig-gh-<owner>']],
      ['git grep -O teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git grep -nOcat teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git grep --open-files-in-pager=cat teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git -c core.pager=cat grep teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git --config-env=core.pager=P grep teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git log --grep teamrig-gh-', ['teamrig-gh-<owner>']],
      ['grep -rn teamrig-ship-gh .', ['teamrig-ship-gh']],
      ['git grep "$(gh auth token)" teamrig-gh-', ['gh auth token', 'teamrig-gh-<owner>']],
      ['git grep keytar', ['keytar']],
      ['GIT_PAGER=less git grep teamrig-gh-', ['teamrig-gh-<owner>']],
      ['PAGER=less git -p grep teamrig-gh-', ['teamrig-gh-<owner>']],
      ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=less git grep teamrig-gh-', ['teamrig-gh-<owner>']],
      ['env GIT_PAGER=less git grep teamrig-gh-', ['teamrig-gh-<owner>']],
      ['GIT_PAGER=less; git grep teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git -p grep teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git --paginate grep teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git --namespace x grep teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git grep --textconv teamrig-gh-', ['teamrig-gh-<owner>']],
      // git takes any unique prefix of a long option, so each abbreviation of a refused option refuses too.
      ['git grep --open=cat teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git grep --open-files=cat teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git grep --open-files-in-pa=cat teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git grep --textc teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git grep --textco teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git grep --no-ind teamrig-gh- C:/u', ['teamrig-gh-<owner>']],
      ['git grep --no-inde teamrig-gh- C:/u', ['teamrig-gh-<owner>']],
      ['git grep --max-depthX teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git grep -nO teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git grep --untracked teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git --git-dir=.git --work-tree=/ grep teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git --work-tree / grep teamrig-gh-', ['teamrig-gh-<owner>']],
      ['./git grep teamrig-gh-', ['teamrig-gh-<owner>']],
      ['/tmp/git grep teamrig-gh-', ['teamrig-gh-<owner>']],
      ['xargs git grep teamrig-gh- < f', ['teamrig-gh-<owner>']],
      // `-C <dir>` may name a folder that is no repository, which git searches whole under `grep.fallbackToNoIndex`.
      ['git -C C:/w grep -n teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git -CC:/w grep -n teamrig-gh-', ['teamrig-gh-<owner>']],
      // A word the shell expands may hold any option, so the allow-list cannot read it.
      ['git grep $X teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git grep "$X" teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git grep ${X} teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git grep teamrig-gh- -- $X', ['teamrig-gh-<owner>']],
      ['git $X grep teamrig-gh-', ['teamrig-gh-<owner>']],
      // An unquoted glob or `~` is rewritten by bash before git sees it, so it may expand to any option too.
      ['git grep * teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git grep ?n teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git grep [-]n teamrig-gh-', ['teamrig-gh-<owner>']],
      ['git grep teamrig-gh- -- *', ['teamrig-gh-<owner>']],
      ['git grep teamrig-gh- -- ~', ['teamrig-gh-<owner>']],
      ['git * grep teamrig-gh-', ['teamrig-gh-<owner>']],
    ];
    for (const [line, via] of cases) {
      assert.deepEqual(reads(line), via, line);
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

  // The clock covers only the patterns under test. Splitting the line into runs costs more than they do, so timing it
  // too failed the bound on a loaded host while the patterns stayed fast (#929). The line repeats each program a store
  // pattern starts with: a pattern without its `^` then retries its lookahead from every copy, which is quadratic and
  // takes seconds on this line, past the bound; with the `^` each pattern looks once.
  it('reads a long line in time in proportion to it', () => {
    const line = `gh ${'gh git git-credential-x security secret-tool cmdkey vaultcmd keyring '.repeat(10_000)}x`;
    const runs = runsOf(line, { cwd: 'C:/w', home: 'C:/u', dialect: 'bash' });
    const started = performance.now();
    assert.deepEqual(credentialReadFindings(line, runs, NO_SEARCH_START), []);
    const took = performance.now() - started;
    assert.ok(took < 2_000, `took ${Math.round(took)} ms`);
  });
});
