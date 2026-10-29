import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { Env } from '../core/home.ts';
import { FakePathProbe } from '../testing/fake-processes.ts';
import { parseClientManifest } from './client-integrity.ts';
import { CLIENT_ENTRIES, ClientInstalls, placeProgram, placeScript, ShellPathSearch, type ClientSearch, type WordAt } from './client-launch.ts';

const BASH: WordAt = { dialect: 'bash', dir: 'C:/w', home: 'C:/u' };
const CACHE = 'C:/u/.claude/plugins/cache/teamrig/teamrig';

/** A search that finds only the names it is given. */
function searchOf(found: Readonly<Record<string, string>> = {}): ClientSearch & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    find: (name) => {
      asked.push(name);
      return Promise.resolve(found[name]);
    },
  };
}

function search(platform: NodeJS.Platform, env: Env, files: readonly string[]): ShellPathSearch {
  return new ShellPathSearch({ env, platform, probe: new FakePathProbe({ files }) });
}

describe('placeProgram', () => {
  it('places a word with a folder as a path from the program’s folder, a Git Bash drive path as Windows names it', async () => {
    const none = searchOf();
    assert.deepEqual(await placeProgram('/c/kit/bin/teamrig', BASH, none), { kind: 'file', path: win32.resolve('C:/kit/bin/teamrig'), by: 'written' });
    assert.deepEqual(await placeProgram('kit/bin/teamrig', BASH, none), { kind: 'file', path: win32.resolve('C:/w/kit/bin/teamrig'), by: 'written' });
    assert.deepEqual(await placeProgram('~/kit/bin/teamrig', BASH, none), { kind: 'file', path: win32.resolve('C:/u/kit/bin/teamrig'), by: 'written' });
    assert.deepEqual(await placeProgram('.\\bin\\teamrig.cmd', { ...BASH, dialect: 'powershell' }, none), { kind: 'file', path: win32.resolve('C:/w/bin/teamrig.cmd'), by: 'written' });
    assert.deepEqual(none.asked, []);
  });

  it('leaves a relative path unplaced when the program’s folder is only known when the line runs', async () => {
    assert.deepEqual(await placeProgram('kit/bin/teamrig', { ...BASH, dir: undefined }, searchOf()), { kind: 'unplaced' });
    assert.deepEqual(placeScript('dist/cli/main.js', { ...BASH, dir: undefined }), { kind: 'unplaced' });
  });

  it('looks a bare name up as the shell does: the file it finds, else the plugin bin the Bash tool’s PATH ends with', async () => {
    const shadow = searchOf({ teamrig: 'C:/u/bin/teamrig' });
    assert.deepEqual(await placeProgram('teamrig', BASH, shadow), { kind: 'file', path: 'C:/u/bin/teamrig', by: 'found' });
    assert.deepEqual(await placeProgram('teamrig', BASH, searchOf()), { kind: 'appended' });
  });
});

describe('ShellPathSearch', () => {
  const windowsPath = { Path: 'C:\\npm;C:\\tools' };

  it('puts ~/bin before PATH for Bash, tries <name> and <name>.exe on Windows, and finds the first', async () => {
    const shadow = win32.join('C:/u', 'bin', 'teamrig');
    assert.equal(await search('win32', windowsPath, [shadow, win32.join('C:\\npm', 'teamrig')]).find('teamrig', BASH), shadow);
    assert.equal(await search('win32', windowsPath, [win32.join('C:\\tools', 'teamrig.exe')]).find('teamrig', BASH), win32.join('C:\\tools', 'teamrig.exe'));
    assert.equal(await search('win32', windowsPath, [win32.join('C:\\npm', 'teamrig.cmd')]).find('teamrig', BASH), undefined, 'Bash never runs a .cmd for a bare name');
  });

  it('searches PATH alone for PowerShell, with .ps1 and the PATHEXT extensions', async () => {
    const at: WordAt = { ...BASH, dialect: 'powershell' };
    const cmd = win32.join('C:\\npm', 'teamrig.cmd');
    assert.equal(await search('win32', windowsPath, [win32.join('C:/u', 'bin', 'teamrig'), cmd]).find('teamrig', at), cmd);
    assert.equal(await search('win32', { ...windowsPath, PATHEXT: '.EXE' }, [cmd]).find('teamrig', at), undefined);
    assert.equal(await search('win32', windowsPath, [win32.join('C:\\tools', 'teamrig.ps1')]).find('teamrig', at), win32.join('C:\\tools', 'teamrig.ps1'));
  });

  it('searches the program’s folder before PATH for cmd, and nothing more when that folder is only known when it runs', async () => {
    const here = win32.join('C:/w', 'teamrig.cmd');
    const at: WordAt = { ...BASH, dialect: 'cmd' };
    assert.equal(await search('win32', windowsPath, [here]).find('teamrig', at), here);
    assert.equal(await search('win32', windowsPath, [here]).find('teamrig', { ...at, dir: undefined }), undefined);
  });

  it('searches with the host’s own rules elsewhere: <name> for Bash, .ps1 first for PowerShell', async () => {
    const home: WordAt = { dialect: 'bash', dir: '/w', home: '/u' };
    const env = { PATH: '/usr/bin:/opt/kit' };
    assert.equal(await search('linux', env, [posix.join('/u', 'bin', 'teamrig')]).find('teamrig', home), posix.join('/u', 'bin', 'teamrig'));
    assert.equal(await search('linux', env, [posix.join('/opt/kit', 'teamrig.ps1')]).find('teamrig', { ...home, dialect: 'powershell' }), posix.join('/opt/kit', 'teamrig.ps1'));
    assert.equal(await search('linux', {}, []).find('teamrig', home), undefined);
  });
});

describe('ClientInstalls', () => {
  const cached = new ClientInstalls(`${CACHE}/0.155.1`, 'win32');

  it('gives the install root of each entry of this install, ignoring case and slashes on Windows', () => {
    for (const entry of CLIENT_ENTRIES) {
      assert.equal(cached.rootOf(`${CACHE}/0.155.1/${entry}`), `${CACHE}/0.155.1`, entry);
    }
    assert.equal(cached.rootOf('C:\\U\\.claude\\plugins\\cache\\teamrig\\teamrig\\0.155.1\\BIN\\teamrig.CMD'), 'C:/U/.claude/plugins/cache/teamrig/teamrig/0.155.1');
    assert.equal(cached.isOwn('C:\\u\\.claude\\plugins\\cache\\teamrig\\teamrig\\0.155.1\\'), true);
  });

  it('takes another version beside it in the cache, which a tab keeps on PATH, as an install', () => {
    const older = `${CACHE}/0.152.0`;
    assert.equal(cached.rootOf(`${older}/bin/teamrig`), older);
    assert.equal(cached.isOwn(older), false);
  });

  it('takes no other file: not a launcher it does not ship, a folder that is no version, or another place', () => {
    for (const file of [
      `${CACHE}/0.155.1/bin/teamrig.ps1`,
      `${CACHE}/0.155.1/bin/teamrig.exe`,
      `${CACHE}/patched/bin/teamrig`,
      `${CACHE}/0.155.1/../../evil/0.1.0/bin/teamrig`,
      'C:/u/bin/teamrig',
      'C:/src/teamrig/plugins/teamrig/bin/teamrig',
      'C:/src/teamrig/src/cli/main.ts',
    ]) {
      assert.equal(cached.rootOf(file), undefined, file);
    }
  });

  it('takes only the plugin folder itself for a plugin run from a checkout, and keeps case elsewhere', () => {
    const checkout = new ClientInstalls('C:/src/teamrig/plugins/teamrig', 'win32');
    assert.equal(checkout.rootOf('C:/src/teamrig/plugins/teamrig/bin/teamrig'), 'C:/src/teamrig/plugins/teamrig');
    assert.equal(checkout.rootOf('C:/src/teamrig/plugins/0.1.0/bin/teamrig'), undefined);
    const linux = new ClientInstalls('/u/cache/teamrig/0.155.1/', 'linux');
    assert.equal(linux.rootOf('/u/cache/teamrig/0.155.1/dist/cli/main.js'), '/u/cache/teamrig/0.155.1');
    assert.equal(linux.rootOf('/u/cache/teamrig/0.155.1/BIN/teamrig'), undefined);
  });

  it('knows its own bash launcher, ignoring case and slashes on Windows, and no other version or entry', () => {
    assert.equal(cached.isOwnLauncher(`${CACHE}/0.155.1/bin/teamrig`), true);
    assert.equal(cached.isOwnLauncher('C:\\U\\.claude\\plugins\\cache\\teamrig\\teamrig\\0.155.1\\BIN\\.\\teamrig'), true);
    for (const file of [`${CACHE}/0.152.0/bin/teamrig`, `${CACHE}/0.155.1/bin/teamrig.cmd`, `${CACHE}/0.155.1/bin/teamrig.exe`, `${CACHE}/0.155.1/dist/cli/main.js`, 'C:/u/bin/teamrig']) {
      assert.equal(cached.isOwnLauncher(file), false, file);
    }
    assert.equal(new ClientInstalls('/u/cache/teamrig/0.155.1', 'linux').isOwnLauncher('/u/cache/teamrig/0.155.1/BIN/teamrig'), false);
  });

  it('names only entries the build hashes, so a changed entry fails the client check', async () => {
    const text = await readFile(new URL('../../plugins/teamrig/dist/integrity.json', import.meta.url), 'utf8');
    const listed = parseClientManifest(text);
    assert.ok(listed !== undefined);
    assert.deepEqual(CLIENT_ENTRIES.filter((entry) => !listed.has(entry)), []);
  });
});
