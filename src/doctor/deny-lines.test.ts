import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { HostPermissions } from '../ports/host/index.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { shippedPermissions } from '../testing/shipped-permissions.ts';
import { missingDenyLines, readSettingsDeny } from './deny-lines.ts';

const USER = join('/u/.claude', 'settings.json');
const SHARED = join('/w/app', '.claude', 'settings.json');
const LOCAL = join('/w/app', '.claude', 'settings.local.json');
const PERMISSIONS = shippedPermissions();
const LINES = PERMISSIONS.denyLines('linux');

describe('readSettingsDeny', () => {
  it("reads each file's deny lines through the host", async () => {
    const host: HostPermissions = { ...PERMISSIONS, read: (settings) => ({ ...PERMISSIONS.read(settings), deny: ['Refuse(all)'] }) };
    const files = new MemoryFiles({ [USER]: JSON.stringify({ rules: [] }) });
    assert.deepEqual(await readSettingsDeny(host, files, [USER, SHARED]), [{ kind: 'deny', path: USER, deny: ['Refuse(all)'] }]);
  });

  it('reads the deny strings of each file that exists, in order, leaving out a missing one and anything not a string', async () => {
    const files = new MemoryFiles({
      [USER]: JSON.stringify({ permissions: { allow: ['Bash(git log)'], deny: ['Bash(env)', 7, 'Read(~/.npmrc)'] } }),
      [LOCAL]: JSON.stringify({ permissions: { deny: ['Read(//**/.env)'] } }),
    });
    assert.deepEqual(await readSettingsDeny(PERMISSIONS, files, [USER, SHARED, LOCAL]), [
      { kind: 'deny', path: USER, deny: ['Bash(env)', 'Read(~/.npmrc)'] },
      { kind: 'deny', path: LOCAL, deny: ['Read(//**/.env)'] },
    ]);
  });

  it('reads no lines from a file without permissions, or whose deny is no list', async () => {
    const files = new MemoryFiles({
      [USER]: JSON.stringify({ model: 'opus' }),
      [SHARED]: JSON.stringify({ permissions: { deny: 'Bash(env)' } }),
    });
    assert.deepEqual(await readSettingsDeny(PERMISSIONS, files, [USER, SHARED]), [
      { kind: 'deny', path: USER, deny: [] },
      { kind: 'deny', path: SHARED, deny: [] },
    ]);
  });

  it('marks a file that is not a JSON object unreadable, and skips a leading byte order mark', async () => {
    const files = new MemoryFiles({ [USER]: '{ not json', [LOCAL]: `\u{FEFF}${JSON.stringify({ permissions: { deny: ['Bash(env)'] } })}` });
    assert.deepEqual(await readSettingsDeny(PERMISSIONS, files, [USER, LOCAL]), [
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
