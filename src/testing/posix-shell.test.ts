import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { delimiter } from 'node:path';
import { gitUsrBin, posixShellEnvironment, type ShellProbe } from './posix-shell.ts';

const GIT_BIN = 'C:/Program Files/Git/usr/bin';
/**
 * A Git install with no drive letter, for the specs that split PATH: on Linux and macOS the delimiter is `:`, which
 * would cut a `C:/` folder in two.
 */
const ROOT = '/opt/Git';
const ROOT_BIN = `${ROOT}/usr/bin`;
const ROOT_EXEC = `${ROOT}/mingw64/libexec/git-core`;

/** A probe where `sh` runs only when PATH holds one of `shellFolders`. */
function probeOf(shellFolders: readonly string[], execPath: string | undefined): ShellProbe & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    runs: (env) => {
      const path = Object.entries(env).find(([name]) => name.toUpperCase() === 'PATH')?.[1] ?? '';
      asked.push(path);
      return path.split(delimiter).some((folder) => shellFolders.includes(folder));
    },
    gitExecPath: () => execPath,
  };
}

describe('gitUsrBin', () => {
  it('finds usr/bin from a Git for Windows exec path, whatever its slashes or toolchain', () => {
    assert.equal(gitUsrBin('C:/Program Files/Git/mingw64/libexec/git-core'), GIT_BIN);
    assert.equal(gitUsrBin('C:\\Program Files\\Git\\clangarm64\\libexec\\git-core\\\n'), GIT_BIN);
  });

  it('finds nothing for an exec path of another shape', () => {
    assert.equal(gitUsrBin('/usr/lib/git-core'), undefined);
    assert.equal(gitUsrBin(''), undefined);
  });
});

describe('posixShellEnvironment', () => {
  it('keeps the environment as it is where sh is on its PATH', () => {
    const env = { PATH: `/usr/bin${delimiter}/bin` };
    assert.equal(posixShellEnvironment(env, probeOf(['/usr/bin'], undefined)), env);
  });

  it("puts Git's usr/bin first on PATH, under the name the environment holds it by, where sh is missing (T4103)", () => {
    const env = { Path: `${ROOT}/cmd`, HOME: 'h' };
    const probe = probeOf([ROOT_BIN], ROOT_EXEC);
    assert.deepEqual(posixShellEnvironment(env, probe), { Path: `${ROOT_BIN}${delimiter}${ROOT}/cmd`, HOME: 'h' });
    assert.deepEqual(probe.asked, [`${ROOT}/cmd`, `${ROOT_BIN}${delimiter}${ROOT}/cmd`]);
  });

  it("makes Git's usr/bin the whole PATH where the environment has none", () => {
    const probe = probeOf([ROOT_BIN], ROOT_EXEC);
    assert.deepEqual(posixShellEnvironment({}, probe), { PATH: ROOT_BIN });
  });

  it('finds none where git does not answer or its usr/bin runs no sh', () => {
    assert.equal(posixShellEnvironment({ PATH: '/x' }, probeOf([], undefined)), undefined);
    assert.equal(posixShellEnvironment({ PATH: '/x' }, probeOf([], ROOT_EXEC)), undefined);
    assert.equal(posixShellEnvironment({ PATH: '/x' }, probeOf([ROOT_BIN], '/usr/lib/git-core')), undefined);
  });
});
