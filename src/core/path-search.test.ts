import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakePathProbe } from '../testing/fake-processes.ts';
import type { Env } from './home.ts';
import { envKey, envVariable, findProgram, pathList } from './path-search.ts';

function find(name: string, env: Env, platform: NodeJS.Platform, files: readonly string[]): Promise<string | undefined> {
  return findProgram(name, { env, platform, probe: new FakePathProbe({ files }) });
}

describe('envVariable', () => {
  it('ignores the case of a name on Windows only', () => {
    assert.equal(envVariable({ Path: 'C:\\bin' }, 'PATH', 'win32'), 'C:\\bin');
    assert.equal(envVariable({ Path: '/bin' }, 'PATH', 'linux'), undefined);
    assert.equal(envVariable({}, 'PATH', 'win32'), undefined);
  });
});

describe('envKey', () => {
  it("names the variable as env spells it, ignoring case on Windows only; undefined when it is not set", () => {
    assert.equal(envKey({ Path: 'C:\\bin' }, 'PATH', 'win32'), 'Path');
    assert.equal(envKey({ PATH: '/bin' }, 'PATH', 'linux'), 'PATH');
    assert.equal(envKey({ Path: '/bin' }, 'PATH', 'linux'), undefined);
    assert.equal(envKey({}, 'PATH', 'win32'), undefined);
  });
});

describe('pathList', () => {
  it('trims and unquotes each part and leaves out empty ones', () => {
    assert.deepEqual(pathList(' C:\\a ;"C:\\Program Files\\b";;', ';'), ['C:\\a', 'C:\\Program Files\\b']);
    assert.deepEqual(pathList(undefined, ':'), []);
  });
});

describe('findProgram', () => {
  it('finds git.exe on a Windows PATH, after a git.com in an earlier folder', async () => {
    assert.equal(await find('git', { Path: 'C:\\tools;C:\\Git\\cmd' }, 'win32', ['C:\\Git\\cmd\\git.exe']), 'C:\\Git\\cmd\\git.exe');
    assert.equal(await find('git', { PATH: 'C:\\tools;C:\\Git\\cmd' }, 'win32', ['C:\\tools\\git.com', 'C:\\Git\\cmd\\git.exe']), 'C:\\tools\\git.com');
  });

  it('never takes a git.cmd on Windows: Node.js does not start one without a shell', async () => {
    assert.equal(await find('git', { PATH: 'C:\\Git\\cmd' }, 'win32', ['C:\\Git\\cmd\\git.cmd']), undefined);
  });

  it('finds the bare name on a POSIX PATH', async () => {
    assert.equal(await find('git', { PATH: '/usr/local/bin:/usr/bin' }, 'darwin', ['/usr/bin/git']), '/usr/bin/git');
  });

  it('finds nothing when no PATH folder has it, or there is no PATH', async () => {
    assert.equal(await find('git', { PATH: '/usr/bin' }, 'linux', ['/opt/git']), undefined);
    assert.equal(await find('git', {}, 'linux', ['/usr/bin/git']), undefined);
  });
});
