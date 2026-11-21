import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TempRepo } from '../../tools/lib/temp-repo.ts';
import { testPaths } from '../testing/host.ts';
import { DEFAULT_SECRET_PATHS, normalisePath, SecretPaths, wordPath, type WordPlace, type WordReading } from './paths.ts';
import { PUBLIC_KEY_MAX_BYTES, readKeyText } from './public-key.ts';

const HOME = 'C:/u';
const REPO = 'C:/work/app';
/** The list a run on the shipped host reads (`secretRulesOf`): the defaults, the host's own secret files, then a team's globs. */
const secrets = new SecretPaths([...DEFAULT_SECRET_PATHS, ...testPaths().secretFiles(), 'k8s/secrets/secrets.yaml', '~/.teamrig/teams/*/tools/*/secrets/**'], HOME, true);
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

describe('SecretPaths: a .pub.pem file holding public keys alone (#875)', () => {
  // Keys made at run time, so no key-shaped text sits in the source.
  const dashes = '-----';
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ed = generateKeyPairSync('ed25519');
  const PUBLIC = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
  const PKCS1 = rsa.publicKey.export({ type: 'pkcs1', format: 'pem' }).toString().trim();
  const ED = ed.publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
  const PRIVATE = ed.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim();
  const relabel = (pem: string, label: string): string => pem.replace(/BEGIN [A-Z ]+-/u, `BEGIN ${label}-`).replace(/END [A-Z ]+-/u, `END ${label}-`);
  const bodyOf = (pem: string): string[] => pem.split('\n').slice(1, -1);
  const block = (label: string, body: readonly string[]): string => [`${dashes}BEGIN ${label}${dashes}`, ...body, `${dashes}END ${label}${dashes}`].join('\n');
  const wrap = (label: string, der: Buffer): string => block(label, der.toString('base64').match(/.{1,64}/gu) ?? []);
  const EXTRA = Buffer.from('extra bytes after the key');
  const files: Readonly<Record<string, string>> = {
    [`${REPO}/keys/archive.pub.pem`]: PUBLIC,
    [`${REPO}/keys/two.pub.pem`]: `${PUBLIC}\r\n\r\n${PKCS1}\n\n${ED}\n`,
    [`${REPO}/keys/mistake.pub.pem`]: PRIVATE,
    [`${REPO}/keys/rsa.pub.pem`]: relabel(PKCS1, 'RSA PRIVATE KEY'),
    [`${REPO}/keys/both.pub.pem`]: `${PUBLIC}\n${PRIVATE}`,
    [`${REPO}/keys/noted.pub.pem`]: `${PUBLIC}\nnote: see the vault`,
    [`${REPO}/keys/open.pub.pem`]: PUBLIC.slice(0, PUBLIC.lastIndexOf('\n')),
    [`${REPO}/keys/empty.pub.pem`]: '',
    [`${REPO}/keys/cert.pub.pem`]: relabel(PUBLIC, 'CERTIFICATE'),
    [`${REPO}/keys/archive.pem`]: PUBLIC,
    // A key-shaped label around something that is not a public key: the content check parses each block.
    [`${REPO}/keys/label.pub.pem`]: relabel(PUBLIC, 'PRIVATE PUBLIC KEY'),
    [`${REPO}/keys/sealed.pub.pem`]: relabel(PUBLIC, 'ENCRYPTED PRIVATE PUBLIC KEY'),
    [`${REPO}/keys/relabelled.pub.pem`]: relabel(PRIVATE, 'PUBLIC KEY'),
    [`${REPO}/keys/relabelled-rsa.pub.pem`]: relabel(PRIVATE, 'RSA PUBLIC KEY'),
    [`${REPO}/keys/token.pub.pem`]: block('PUBLIC KEY', ['A'.repeat(20) + 'b'.repeat(20)]),
    [`${REPO}/keys/hex.pub.pem`]: block('PUBLIC KEY', ['0123456789abcdef'.repeat(2) + '01234567']),
    [`${REPO}/keys/cut.pub.pem`]: block('PUBLIC KEY', bodyOf(PUBLIC).slice(1)),
    // A real public key's DER with other bytes behind it, or base64 behind its padding: the key must be the whole body.
    [`${REPO}/keys/tail.pub.pem`]: wrap('PUBLIC KEY', Buffer.concat([rsa.publicKey.export({ type: 'spki', format: 'der' }), EXTRA])),
    [`${REPO}/keys/tail-rsa.pub.pem`]: wrap('RSA PUBLIC KEY', Buffer.concat([rsa.publicKey.export({ type: 'pkcs1', format: 'der' }), EXTRA])),
    [`${REPO}/keys/padded.pub.pem`]: block('PUBLIC KEY', [...bodyOf(ED), EXTRA.toString('base64')]),
  };
  const read = (path: string): string | undefined => files[path];
  const keyed = new SecretPaths(DEFAULT_SECRET_PATHS, HOME, true, read);

  it('allows one that holds PUBLIC KEY blocks and nothing else, by path and by a word naming it', () => {
    for (const name of ['archive', 'two']) {
      assert.equal(keyed.listed(`${REPO}/keys/${name}.pub.pem`), false, name);
      assert.equal(keyed.mayName(`${REPO}/keys/${name}.pub.pem`, BASH_WORD), false, name);
    }
  });

  it('refuses one with a private key block, other text, an open block, no block, one that cannot be read, or a key-shaped label around anything but a public key', () => {
    for (const name of ['mistake', 'rsa', 'both', 'noted', 'open', 'empty', 'cert', 'gone', 'label', 'sealed', 'relabelled', 'relabelled-rsa', 'token', 'hex', 'cut', 'tail', 'tail-rsa', 'padded']) {
      assert.equal(keyed.listed(`${REPO}/keys/${name}.pub.pem`), true, name);
      assert.equal(keyed.mayName(`${REPO}/keys/${name}.pub.pem`, BASH_WORD), true, name);
    }
  });

  it('keeps refusing any other .pem, a word with wildcards, and a .pub.pem a team glob names', () => {
    assert.equal(keyed.listed(`${REPO}/keys/archive.pem`), true);
    assert.equal(keyed.mayName(`${REPO}/keys/*.pub.pem`, BASH_WORD), true);
    const named = new SecretPaths([...DEFAULT_SECRET_PATHS, 'keys/*.pub.pem'], HOME, true, read);
    assert.equal(named.listed(`${REPO}/keys/archive.pub.pem`), true);
  });

  it('reads no file and refuses as before without a reader', () => {
    assert.equal(secrets.listed(`${REPO}/keys/archive.pub.pem`), true);
  });
});

describe('readKeyText (#875)', () => {
  it('reads a small file, and nothing of a folder, a missing file or one past the limit', () => {
    const repo = new TempRepo('pub-pem');
    try {
      writeFileSync(join(repo.dir, 'a.pub.pem'), 'text');
      writeFileSync(join(repo.dir, 'big.pub.pem'), 'x'.repeat(PUBLIC_KEY_MAX_BYTES + 1));
      assert.equal(readKeyText(join(repo.dir, 'a.pub.pem')), 'text');
      assert.equal(readKeyText(join(repo.dir, 'big.pub.pem')), undefined);
      assert.equal(readKeyText(join(repo.dir, 'gone.pub.pem')), undefined);
      assert.equal(readKeyText(repo.dir), undefined);
    } finally {
      repo.remove();
    }
  });

  it('returns at once, with nothing, for a device that never ends and a pipe no one writes, which a blocking open would wait on', () => {
    const repo = new TempRepo('pub-pem-fifo');
    try {
      assert.equal(readKeyText(process.platform === 'win32' ? 'NUL' : '/dev/zero'), undefined);
      if (process.platform !== 'win32') {
        const fifo = join(repo.dir, 'pipe.pub.pem');
        execFileSync('mkfifo', [fifo]);
        assert.equal(readKeyText(fifo), undefined);
      }
    } finally {
      repo.remove();
    }
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
