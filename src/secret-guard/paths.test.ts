import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECRET_PATHS, normalisePath, SecretPaths, wordPath, type WordPlace } from './paths.ts';

const HOME = 'C:/u';
const REPO = 'C:/work/app';
const secrets = new SecretPaths([...DEFAULT_SECRET_PATHS, 'k8s/secrets/secrets.yaml', '~/.teamrig/teams/*/tools/*/secrets/**'], HOME, true);

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
    assert.equal(secrets.mayName(`${REPO}/.env*`, false), true);
    assert.equal(secrets.mayName(`${HOME}/.ssh/*`, false), true);
    assert.equal(secrets.mayName(`${REPO}/infra/k8s/secrets/*`, true), true);
    assert.equal(secrets.mayName(`${REPO}/*.txt`, false), false);
    assert.equal(secrets.mayName(`${REPO}/certs/*.pem`, false), true);
  });

  it('tries a name of wildcards alone only against names spelled out and secret folders', () => {
    assert.equal(secrets.mayName(`${REPO}/certs/*`, false), false);
    assert.equal(secrets.mayName(`${HOME}/.aws/*`, false), true);
  });

  it('tries a name of wildcards alone against a plain name only where the glob spells out its folder', () => {
    const team = new SecretPaths([...DEFAULT_SECRET_PATHS, 'deploy_key', 'ops/vault_key'], HOME, true);
    assert.equal(team.listed(`${REPO}/src/deploy_key`), true);
    assert.equal(team.mayName(`${REPO}/src/*`, false), false, 'else every grep x * would name a deploy_key');
    assert.equal(team.mayName(`${REPO}/src/deploy*`, false), true);
    assert.equal(team.mayName(`${REPO}/ops/*`, false), true);
    assert.equal(secrets.mayName(`${REPO}/deploy/*`, false), false);
    assert.equal(secrets.mayName(`${REPO}/deploy/id_*`, false), true);
  });

  it('never lets a bash wildcard reach a dot file, as bash does not', () => {
    assert.equal(secrets.mayName(`${REPO}/*`, false), false);
    assert.equal(secrets.mayName(`${REPO}/*`, true), true);
  });

  it('keeps an example a wildcard names readable', () => {
    assert.equal(secrets.mayName(`${REPO}/.env.ex*`, false), false);
  });

  it('sees a secret name behind a reversed range, as bash reaches it (T1960)', () => {
    assert.equal(secrets.mayName(`${REPO}/.en[z-av]`, false), true);
    assert.equal(secrets.mayName(`${REPO}/near[near.length-1]`, false), false);
  });

  it('reads a word with a set no character fits as the literal path bash leaves it (T1960)', () => {
    assert.equal(secrets.mayName(`${REPO}/.env.[z-a]`, false), true);
    assert.equal(secrets.mayName(`${REPO}/.env.[z-a]*`, false), true);
    assert.equal(secrets.mayName(`${REPO}/[z-a]env`, false), false);
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
