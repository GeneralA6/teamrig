import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { maskCommand } from './log-mask.ts';

/** Secret-shaped values are assembled at run time so none sits in the source for the scrub to flag. */
const join = (...parts: string[]): string => parts.join('');
const VALUE = join('Qx7mRt', '9wLp4Zn');
/** A 44-character base64 value, as a 32-byte key encodes one. */
const BASE64 = join('q8Zr3Kx0', 'Wm5Tn2Bv', 'Lp7Yc4Hd', '9Fs1Gj6A', 'kE3uRw0Qz', '3=');
const SCANNER = new SecretScanner();
const mask = (command: string): string => maskCommand(command, SCANNER);

describe('maskCommand', () => {
  it('masks a token given as a query or a flag parameter (T1986 M3)', () => {
    assert.equal(mask(join('curl "https://api.example.com/x?access_', 'token=', VALUE, '&page=2"')), 'curl "https://api.example.com/x?access_token=[redacted]&page=2"');
    assert.equal(mask(join('deploy --to', 'ken=', VALUE, ' --env prod')), 'deploy --token=[redacted] --env prod');
  });

  it('masks the value after a secret-named flag and a space', () => {
    for (const flag of ['--token', '--password', '--api-key', '--client-secret', '-Secret']) {
      assert.equal(mask(join('tool ', flag, ' ', VALUE, ' --verbose')), join('tool ', flag, ' [redacted] --verbose'), flag);
    }
    assert.equal(mask(join('tool --pass', 'word "two ', 'words here"')), 'tool --password [redacted]');
  });

  it('keeps a flag that only names where a secret comes from, and the flag after a bare secret flag', () => {
    assert.equal(mask('docker login --password-stdin -u app registry.local'), 'docker login --password-stdin -u app registry.local');
    assert.equal(mask('tool --token --verbose'), 'tool --token --verbose');
    assert.equal(mask('tool --secret-file ./k.pem'), 'tool --secret-file ./k.pem');
  });

  it('masks the password of a login and password flag, and keeps the login (C11)', () => {
    assert.equal(mask(join('curl -u app:', VALUE, ' https://api.local')), 'curl -u app:[redacted] https://api.local');
    assert.equal(mask(join("curl --user 'app:", VALUE, "' https://api.local")), "curl --user 'app:[redacted]' https://api.local");
    assert.equal(mask('sort -u names.txt'), 'sort -u names.txt');
    assert.equal(mask('git push -u origin t1986-log-mask'), 'git push -u origin t1986-log-mask');
  });

  it("masks sshpass's -p value and mysql's attached -p value; a bare -p keeps its next word", () => {
    assert.equal(mask(join('sshpass -p ', VALUE, ' ssh app@host')), 'sshpass -p [redacted] ssh app@host');
    assert.equal(mask(join('mysql -u app -p', VALUE, ' shop')), 'mysql -u app -p[redacted] shop');
    assert.equal(mask('mkdir -p build/out'), 'mkdir -p build/out');
  });

  it('masks a long base64 run, and keeps a path, a hex hash and a long name (T1986 M3)', () => {
    assert.equal(mask(join('echo ', BASE64, ' | base64 -d')), 'echo [redacted] | base64 -d');
    const kept = [
      'ls /c/Work/app/worktrees/t1986-log-mask/src/hooks/permissions',
      join('git show ', 'a1b2c3d4e5f6'.repeat(5), 'abcd'),
      'node tools/docs/RefusalTextsNameTheSanctionedRouteForEveryGuard.ts',
    ];
    for (const command of kept) {
      assert.equal(mask(command), command);
    }
  });

  it('masks the value of an env name ending in a secret word, in each shell form (C11)', () => {
    const lines: readonly (readonly [string, string])[] = [
      [join('API_TO', 'KEN=', VALUE, ' npm start'), 'API_TOKEN=[redacted] npm start'],
      [join('export DB_', 'URI=', VALUE), 'export DB_URI=[redacted]'],
      [join("$env:GH_TO", "KEN='", VALUE, "'; gh pr list"), '$env:GH_TOKEN=[redacted]; gh pr list'],
      [join("$env:APP_SEC", "RET = '", 'two ', "words'"), '$env:APP_[redacted password or key assignment]'],
      [join('SIGNING_', 'KEY=', VALUE, ' make sign'), 'SIGNING_KEY=[redacted] make sign'],
    ];
    for (const [command, masked] of lines) {
      assert.equal(mask(command), masked, masked);
    }
  });

  it('masks a quoted password with spaces in it', () => {
    assert.equal(mask(join('login pass', 'word="', 'correct horse ', 'battery"', ' --save')), 'login [redacted password or key assignment] --save');
  });

  it('keeps a name that only ends near a secret word, and a value-free line', () => {
    for (const command of ['TOKEN_LIMIT=200000 npm test', 'git status --short', 'teamrig list --session tr-guards']) {
      assert.equal(mask(command), command);
    }
  });

  it("still takes a URL's user part and the scanner's token shapes", () => {
    const token = join('gh', 'p_', 'a1'.repeat(18));
    assert.equal(mask(join('git clone https://', token, '@github.com/o/r')), 'git clone https://[redacted]@github.com/o/r');
    assert.equal(mask(join('echo ', token)), 'echo [redacted GitHub token]');
  });
});
