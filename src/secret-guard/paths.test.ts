import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECRET_PATHS, normalisePath, SecretPaths, wordPath, type WordPlace, type WordReading } from './paths.ts';

const HOME = 'C:/u';
const REPO = 'C:/work/app';
const secrets = new SecretPaths([...DEFAULT_SECRET_PATHS, 'k8s/secrets/secrets.yaml', '~/.teamrig/teams/*/tools/*/secrets/**'], HOME, true);
/** A bash word, whose wildcards never reach a leading dot, and a word whose wildcards do (PowerShell, a script's glob). */
const BASH_WORD: WordReading = { dotfiles: false, sets: 'bash' };
const ANY_WORD: WordReading = { dotfiles: true, sets: 'bash' };

describe('SecretPaths.listed', () => {
  it('lists the well-known credential homes and the team’s own globs', () => {
    const listed = [
      `${REPO}/.env`,
      `${REPO}/api/.env.local`,
      `${HOME}/.npmrc`,
      `${HOME}/.ssh/id_ed25519`,
      `${HOME}/.aws/credentials`,
      `${HOME}/.kube/config`,
      `${HOME}/.docker/config.json`,
      `${HOME}/.git-credentials`,
      `${HOME}/.config/gh/hosts.yml`,
      `${HOME}/AppData/Roaming/GitHub CLI/hosts.yml`,
      `${HOME}/.claude/.credentials.json`,
      `${HOME}/.claude/history.jsonl`,
      `${REPO}/.claude/settings.local.json`,
      `${REPO}/.claude/worktrees/fix/.claude/settings.local.json`,
      `${HOME}/.bash_history`,
      `${HOME}/.zsh_history`,
      `${HOME}/AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt`,
      `${HOME}/.local/share/powershell/PSReadLine/ConsoleHost_history.txt`,
      `${REPO}/certs/tls.pem`,
      `${REPO}/certs/tls.key`,
      `${REPO}/certs/client.p12`,
      `${REPO}/certs/client.pfx`,
      `${REPO}/android/release.jks`,
      `${HOME}/.android/debug.keystore`,
      `${REPO}/deploy/id_rsa`,
      `${REPO}/deploy/id_ecdsa`,
      `${REPO}/deploy/id_ed25519`,
      `${REPO}/ops/.kube/config`,
      `${REPO}/.git-credentials`,
      `${REPO}/infra/terraform.tfstate`,
      `${REPO}/infra/terraform.tfstate.backup`,
      `${REPO}/infra/k8s/secrets/secrets.yaml`,
      `${HOME}/.teamrig/teams/solo/tools/probe/secrets/a.json`,
    ];
    assert.deepEqual(listed.filter((path) => !secrets.listed(path)), []);
  });

  it('keeps the examples, public keys and look-alikes readable', () => {
    const readable = [
      `${REPO}/.env.example`,
      `${REPO}/.env.sample`,
      `${HOME}/.ssh/id_ed25519.pub`,
      `${REPO}/deploy/id_rsa.pub`,
      `${REPO}/src/keystore.ts`,
      `${REPO}/infra/main.tf`,
      `${REPO}/docs/id_rsa.md`,
      `${REPO}/.npmrc`,
      `${REPO}/k8s/secrets/secrets.yaml.example`,
      `${REPO}/.claude/settings.json`,
      `${HOME}/.claude/settings.json`,
      `${HOME}/.claude/projects/app/history.jsonl`,
      `${REPO}/.bash_history`,
      `${REPO}/src/env.ts`,
      `${REPO}/keys.ts`,
    ];
    assert.deepEqual(readable.filter((path) => secrets.listed(path)), []);
  });

  it('lets a later !glob keep a default readable, and reads Windows paths in any case', () => {
    const team = new SecretPaths([...DEFAULT_SECRET_PATHS, '!**/fixtures/*.pem'], HOME, true);
    assert.equal(team.listed(`${REPO}/test/fixtures/fake.pem`), false);
    assert.equal(team.listed('c:\\U\\.NPMRC'), true);
    assert.equal(new SecretPaths(DEFAULT_SECRET_PATHS, '/u', false).listed('/u/.NPMRC'), false);
  });
});

describe('SecretPaths.mayName', () => {
  it('takes a word with wildcards as naming a secret when a secret name fits it', () => {
    assert.equal(secrets.mayName(`${REPO}/.env*`, BASH_WORD), true);
    assert.equal(secrets.mayName(`${HOME}/.ssh/*`, BASH_WORD), true);
    assert.equal(secrets.mayName(`${REPO}/infra/k8s/secrets/*`, ANY_WORD), true);
    assert.equal(secrets.mayName(`${REPO}/*.txt`, BASH_WORD), false);
    assert.equal(secrets.mayName(`${REPO}/certs/*.pem`, BASH_WORD), true);
  });

  it('tries a name of wildcards alone only against names spelled out and secret folders', () => {
    assert.equal(secrets.mayName(`${REPO}/certs/*`, BASH_WORD), false);
    assert.equal(secrets.mayName(`${HOME}/.aws/*`, BASH_WORD), true);
  });

  it('tries a name of wildcards alone against a plain name only where the glob spells out its folder', () => {
    const team = new SecretPaths([...DEFAULT_SECRET_PATHS, 'deploy_key', 'ops/vault_key'], HOME, true);
    assert.equal(team.listed(`${REPO}/src/deploy_key`), true);
    assert.equal(team.mayName(`${REPO}/src/*`, BASH_WORD), false, 'else every grep x * would name a deploy_key');
    assert.equal(team.mayName(`${REPO}/src/deploy*`, BASH_WORD), true);
    assert.equal(team.mayName(`${REPO}/ops/*`, BASH_WORD), true);
    assert.equal(secrets.mayName(`${REPO}/deploy/*`, BASH_WORD), false);
    assert.equal(secrets.mayName(`${REPO}/deploy/id_*`, BASH_WORD), true);
  });

  it('never lets a bash wildcard reach a dot file, as bash does not', () => {
    assert.equal(secrets.mayName(`${REPO}/*`, BASH_WORD), false);
    assert.equal(secrets.mayName(`${REPO}/*`, ANY_WORD), true);
  });

  it('keeps an example a wildcard spells readable, but not a wildcard that also reaches past it (T2357)', () => {
    assert.equal(secrets.mayName(`${REPO}/.env.exampl[e]`, BASH_WORD), false);
    assert.equal(secrets.mayName(`${REPO}/.env.exampl?`, BASH_WORD), true, '.env.exampl? also reads .env.examplz');
    assert.equal(secrets.mayName(`${REPO}/.env.ex*`, BASH_WORD), true, '.env.ex* also reads .env.export');
  });

  it('counts a word that spells a secret glob’s text or whose wildcard its wildcard covers (T2357)', () => {
    assert.equal(secrets.mayName(`${REPO}/.env.l*`, BASH_WORD), true);
    assert.equal(secrets.mayName(`${REPO}/certs/b*.pem`, BASH_WORD), true);
    assert.equal(secrets.mayName(`${REPO}/certs/b?pem`, BASH_WORD), true);
  });

  it('never counts a word that meets a secret glob only where each one’s wildcard covers the other’s text (T2357)', () => {
    assert.equal(secrets.mayName(`${REPO}/*.ts`, ANY_WORD), false, '*.ts fits .env.* only as .env.ts');
    assert.equal(secrets.mayName(`${REPO}/*.json`, ANY_WORD), false);
    assert.equal(secrets.mayName(`${REPO}/src/*.txt`, ANY_WORD), false);
  });

  it('reads a ripgrep set as reaching a slash, and a negated one as fitting it (T2357)', () => {
    const grep: WordReading = { dotfiles: true, sets: 'ripgrep' };
    const holes = ['b[./]pem', 'b[/.]pem', '[./]env*', 'b[!/]pem', 'b[^/]pem', 'b[!a]pem', 'b[^a]pem', 'b[]./]pem', 'b[.-/]pem', '*[/]e.pem'];
    assert.deepEqual(holes.filter((glob) => !secrets.mayName(`${REPO}/${glob}`, grep)), []);
  });

  it('walks a word of many wildcards to its answer', () => {
    assert.equal(secrets.mayName(`${REPO}/${'[ab]*'.repeat(40)}`, ANY_WORD), false, 'a name of wildcards alone, which no dot starts');
    assert.equal(secrets.mayName(`${REPO}/${'[ab]*'.repeat(40)}.pem`, ANY_WORD), true);
  });

  it('sees a secret name behind a reversed range, as bash reaches it (T1960)', () => {
    assert.equal(secrets.mayName(`${REPO}/.en[z-av]`, BASH_WORD), true);
    assert.equal(secrets.mayName(`${REPO}/near[near.length-1]`, BASH_WORD), false);
  });

  it('reads a word with a set no character fits as the literal path bash leaves it (T1960)', () => {
    assert.equal(secrets.mayName(`${REPO}/.env.[z-a]`, BASH_WORD), true);
    assert.equal(secrets.mayName(`${REPO}/.env.[z-a]*`, BASH_WORD), true);
    assert.equal(secrets.mayName(`${REPO}/[z-a]env`, BASH_WORD), false);
  });

  it("survives a team's own glob with a reversed range, which would else fail every call (T1960)", () => {
    const team = new SecretPaths([...DEFAULT_SECRET_PATHS, 'vault[z-a].txt'], HOME, true);
    assert.equal(team.listed(`${REPO}/vault[z-a].txt`), true);
    assert.equal(team.listed(`${REPO}/vaultb.txt`), false);
  });
});

describe('wordPath', () => {
  const bash: WordPlace = { dialect: 'bash', dir: REPO, home: HOME };
  const at = (text: string, place: WordPlace = bash): string => normalisePath(wordPath(text, place));

  it('resolves a relative word in the program’s folder, and ~ and the home variables at home', () => {
    assert.equal(at('.env'), `${REPO}/.env`);
    assert.equal(at('~/.npmrc'), `${HOME}/.npmrc`);
    assert.equal(at('$HOME/.npmrc'), `${HOME}/.npmrc`);
    assert.equal(at('${USERPROFILE}/.npmrc'), `${HOME}/.npmrc`);
    assert.equal(at('$env:USERPROFILE\\.npmrc', { ...bash, dialect: 'powershell' }), `${HOME}/.npmrc`);
    assert.equal(at('%USERPROFILE%\\.npmrc', { ...bash, dialect: 'cmd' }), `${HOME}/.npmrc`);
  });

  it('reads Git Bash drive paths on a Windows host', () => {
    assert.equal(at('/c/u/.npmrc'), `C:/u/.npmrc`);
  });

  it('keeps a part only known when the line runs out of every name a glob spells out', () => {
    assert.equal(secrets.listed(wordPath('$REPO/.env', bash)), true);
    assert.equal(secrets.listed(wordPath('$CONFIG', bash)), false);
    assert.equal(secrets.listed(wordPath('.env', { ...bash, dir: undefined })), true);
    assert.equal(secrets.listed(wordPath('.npmrc', { ...bash, dir: undefined })), false);
  });
});
