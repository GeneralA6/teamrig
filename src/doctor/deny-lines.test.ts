import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { missingDenyLines, readSettingsDeny, secretDenyLines } from './deny-lines.ts';

const USER = join('/u/.claude', 'settings.json');
const SHARED = join('/w/app', '.claude', 'settings.json');
const LOCAL = join('/w/app', '.claude', 'settings.local.json');
const PLATFORMS = ['linux', 'darwin', 'win32'] as const;
const LINES = secretDenyLines('linux');
const GH_POSIX = 'Read(~/.config/gh/hosts.yml)';
const GH_WINDOWS = 'Read(~/AppData/Roaming/GitHub CLI/hosts.yml)';

describe('secretDenyLines', () => {
  it('lists each line once', () => {
    for (const platform of PLATFORMS) {
      const lines = secretDenyLines(platform);
      assert.equal(new Set(lines).size, lines.length, platform);
    }
  });

  it("names gh's hosts file where gh keeps it on the platform, and only there (T2038)", () => {
    const gh = (platform: NodeJS.Platform): string[] => secretDenyLines(platform).filter((line) => line.includes('hosts.yml'));
    assert.deepEqual(gh('win32'), [GH_WINDOWS]);
    assert.deepEqual(gh('linux'), [GH_POSIX]);
    assert.deepEqual(gh('darwin'), [GH_POSIX]);
  });

  it("guards Claude Code's own login on every platform (T2038)", () => {
    for (const platform of PLATFORMS) {
      assert.ok(secretDenyLines(platform).includes('Read(~/.claude/.credentials.json)'), platform);
    }
  });

  it('holds no legacy prefix rule, which misses a call whose argument goes on past the colon', () => {
    assert.deepEqual(
      LINES.filter((line) => line.endsWith(':*)')),
      [],
    );
    assert.ok(LINES.includes('PowerShell(Get-ChildItem env*)'));
  });
});

describe('readSettingsDeny', () => {
  it('reads the deny strings of each file that exists, in order, leaving out a missing one and anything not a string', async () => {
    const files = new MemoryFiles({
      [USER]: JSON.stringify({ permissions: { allow: ['Bash(git log)'], deny: ['Bash(env)', 7, 'Read(~/.npmrc)'] } }),
      [LOCAL]: JSON.stringify({ permissions: { deny: ['Read(//**/.env)'] } }),
    });
    assert.deepEqual(await readSettingsDeny(files, [USER, SHARED, LOCAL]), [
      { kind: 'deny', path: USER, deny: ['Bash(env)', 'Read(~/.npmrc)'] },
      { kind: 'deny', path: LOCAL, deny: ['Read(//**/.env)'] },
    ]);
  });

  it('reads no lines from a file without permissions, or whose deny is no list', async () => {
    const files = new MemoryFiles({
      [USER]: JSON.stringify({ model: 'opus' }),
      [SHARED]: JSON.stringify({ permissions: { deny: 'Bash(env)' } }),
    });
    assert.deepEqual(await readSettingsDeny(files, [USER, SHARED]), [
      { kind: 'deny', path: USER, deny: [] },
      { kind: 'deny', path: SHARED, deny: [] },
    ]);
  });

  it('marks a file that is not a JSON object unreadable, and skips a leading byte order mark', async () => {
    const files = new MemoryFiles({ [USER]: '{ not json', [LOCAL]: `\u{FEFF}${JSON.stringify({ permissions: { deny: ['Bash(env)'] } })}` });
    assert.deepEqual(await readSettingsDeny(files, [USER, LOCAL]), [
      { kind: 'unreadable', path: USER },
      { kind: 'deny', path: LOCAL, deny: ['Bash(env)'] },
    ]);
  });
});

describe('missingDenyLines', () => {
  it('counts a line held in any readable file, spaces at either end aside, and keeps the list order', () => {
    const [first, second, ...rest] = LINES;
    assert.ok(first !== undefined && second !== undefined);
    const read = [
      { kind: 'deny', path: USER, deny: [` ${first} `, ...rest.slice(1)] },
      { kind: 'unreadable', path: SHARED },
      { kind: 'deny', path: LOCAL, deny: ['Bash(git *)'] },
    ] as const;
    assert.deepEqual(missingDenyLines(read, LINES), [second, rest[0]]);
  });

  it('misses a line held only in another form, such as the legacy prefix rule', () => {
    const read = [{ kind: 'deny', path: USER, deny: LINES.map((line) => (line === 'PowerShell(Get-ChildItem env*)' ? 'PowerShell(Get-ChildItem env:*)' : line)) }] as const;
    assert.deepEqual(missingDenyLines(read, LINES), ['PowerShell(Get-ChildItem env*)']);
  });

  it('misses every line when no file is read', () => {
    assert.deepEqual(missingDenyLines([], LINES), [...LINES]);
  });
});
