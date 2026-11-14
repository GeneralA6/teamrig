import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { posix, resolve, win32 } from 'node:path';
import { bashDrivePath, bashNativeWord, Location, resolveDir } from './location.ts';
import { parseShell, type ShellDialect, type ShellWord } from './tokenizer.ts';

const CWD = '/work/app';
const HOME = '/u';

/** Runs every command of `line` through `location`, as the guard does. */
function walk(line: string, dialect: ShellDialect = 'bash', location = new Location(CWD, HOME)): Location {
  for (const command of parseShell(line, dialect).commands) {
    location.enter(command.subshells);
    location.apply(command.words, dialect);
  }
  return location;
}

/** The folder after `line` runs in a location that starts in `start`. */
const dirAfter = (line: string, dialect: ShellDialect = 'bash', start = CWD): string | undefined => walk(line, dialect, new Location(start, HOME)).dir;
const word = (text: string, dynamic = false): ShellWord => ({ text, dynamic });

describe('resolveDir', () => {
  it('resolves relative, absolute and home targets', () => {
    assert.equal(resolveDir(CWD, 'sub', HOME), resolve(CWD, 'sub'));
    assert.equal(resolveDir(CWD, '~', HOME), resolve(HOME));
    assert.equal(resolveDir(CWD, '~/x', HOME), resolve(HOME, 'x'));
    assert.equal(resolveDir(undefined, '/abs', HOME), resolve('/abs'));
    assert.equal(resolveDir(undefined, 'sub', HOME), undefined);
  });

  it('resolves a path with a drive letter by Windows rules on every host', () => {
    assert.equal(resolveDir(CWD, 'D:\\x', HOME), 'D:\\x');
    assert.equal(resolveDir('C:\\work', 'sub', HOME), 'C:\\work\\sub');
    assert.equal(resolveDir('C:\\work', '..\\other', HOME), 'C:\\other');
    assert.equal(resolveDir(CWD, '~/x', 'C:/u'), 'C:\\u\\x');
  });
});

describe('bashDrivePath', () => {
  it('names a Git Bash drive path as Windows does only on a host whose home names a drive, and any other path as it is', () => {
    assert.equal(bashDrivePath('/c/kit/bin/teamrig', 'C:/u'), 'C:/kit/bin/teamrig');
    assert.equal(bashDrivePath('/d', 'C:/u'), 'D:/');
    assert.equal(bashDrivePath('/usr/bin/git', 'C:/u'), '/usr/bin/git');
    assert.equal(bashDrivePath('kit/bin/teamrig', 'C:/u'), 'kit/bin/teamrig');
    assert.equal(bashDrivePath('/c/kit', '/u'), '/c/kit', 'a POSIX host has no drives');
  });
});

describe('bashNativeWord', () => {
  it('turns a /c/x word or an option value into C:/x on a Windows home, as MSYS hands it to git', () => {
    assert.deepEqual(bashNativeWord(word('/c/x'), 'C:/u'), word('C:/x'));
    assert.deepEqual(bashNativeWord(word('--git-dir=/d/r/.git'), 'C:/u'), word('--git-dir=D:/r/.git'));
    assert.deepEqual(bashNativeWord(word('t1-x'), 'C:/u'), word('t1-x'));
    assert.deepEqual(bashNativeWord(word('/c/x', true), 'C:/u'), word('/c/x', true));
    assert.deepEqual(bashNativeWord(word('/c/x'), '/u'), word('/c/x'));
  });
});

describe('Location: the start folder', () => {
  it('resolves and normalises the start folder and home', () => {
    assert.equal(new Location('/work/app/', HOME).dir, resolve(CWD));
    assert.equal(new Location('C:/work/', HOME).dir, 'C:\\work');
    assert.equal(walk('cd', 'bash', new Location(CWD, 'C:/u/')).dir, 'C:\\u');
    assert.equal(new Location(undefined, HOME).dir, undefined);
  });
});

describe('Location: bash', () => {
  it('follows cd, cd -, a bare cd and cd options', () => {
    assert.equal(dirAfter('cd sub'), resolve(CWD, 'sub'));
    assert.equal(dirAfter('cd sub; cd -'), resolve(CWD));
    assert.equal(dirAfter('cd'), resolve(HOME));
    assert.equal(dirAfter('cd -P -- sub other'), resolve(CWD, 'sub'));
    assert.equal(dirAfter('cd "$X"'), undefined);
  });

  it('follows pushd and popd, and stops trusting a rotated stack', () => {
    assert.equal(dirAfter('pushd a && pushd b && popd'), resolve(CWD, 'a'));
    assert.equal(dirAfter('pushd a; pushd'), resolve(CWD));
    assert.equal(dirAfter('pushd'), resolve(CWD));
    assert.equal(dirAfter('popd'), resolve(CWD));
    assert.equal(dirAfter('pushd +1'), undefined);
    assert.equal(dirAfter('pushd a; popd +1'), undefined);
  });

  it('keeps a cd inside its subshell', () => {
    assert.equal(dirAfter('(cd a; git status)'), resolve(CWD, 'a'));
    assert.equal(dirAfter('(cd a); git status'), resolve(CWD));
    assert.equal(dirAfter('(cd a; (cd b; x); y)'), resolve(CWD, 'a'));
  });

  it('applies only folder commands', () => {
    const location = new Location(CWD, HOME);
    assert.equal(location.apply(parseShell('git push', 'bash').commands[0]?.words ?? [], 'bash'), false);
    assert.equal(location.apply([], 'bash'), false);
    assert.equal(location.apply([word('$CD', true), word('x')], 'bash'), false);
    assert.equal(location.dir, resolve(CWD));
  });

  it('starts unknown and learns only absolute folders', () => {
    assert.equal(walk('cd sub', 'bash', new Location(undefined, HOME)).dir, undefined);
    assert.equal(walk('cd /abs', 'bash', new Location(undefined, HOME)).dir, resolve('/abs'));
  });
});

describe('Location: PowerShell', () => {
  it('follows Set-Location and its parameters', () => {
    assert.equal(dirAfter('Set-Location -Path ../ops', 'powershell'), resolve(CWD, '../ops'));
    assert.equal(dirAfter('sl -LiteralPath x', 'powershell'), resolve(CWD, 'x'));
    assert.equal(dirAfter('Set-Location', 'powershell'), resolve(CWD));
    assert.equal(dirAfter('cd x; cd -', 'powershell'), resolve(CWD));
    assert.equal(dirAfter('cd +', 'powershell'), undefined);
  });

  it('follows Push-Location and Pop-Location', () => {
    assert.equal(dirAfter('Push-Location -StackName s x; Pop-Location', 'powershell'), resolve(CWD));
    assert.equal(dirAfter('Push-Location; cd x; Pop-Location', 'powershell'), resolve(CWD));
  });

  it('reads \\ as a separator on a POSIX host too, as PowerShell and cmd do, while bash keeps it in a name', () => {
    const onPosix = (line: string, dialect: ShellDialect): string | undefined => walk(line, dialect, new Location(CWD, HOME, posix)).dir;
    assert.equal(onPosix('Set-Location ..\\other', 'powershell'), '/work/other');
    assert.equal(onPosix('Push-Location sub\\deeper', 'powershell'), '/work/app/sub/deeper');
    assert.equal(onPosix('cd sub\\deeper', 'cmd'), '/work/app/sub/deeper');
    assert.equal(onPosix("cd 'a\\b'", 'bash'), '/work/app/a\\b');
    assert.equal(walk('cd a', 'bash', new Location(CWD, HOME, posix)).child().dir, '/work/app/a');
  });
});

describe('Location: cmd', () => {
  const C = 'C:\\work';

  it('changes drive only with /d, and joins unquoted words', () => {
    assert.equal(dirAfter('cd /d D:\\x', 'cmd', C), 'D:\\x');
    assert.equal(dirAfter('cd D:\\x', 'cmd', C), C);
    assert.equal(dirAfter('cd C:\\other', 'cmd', C), 'C:\\other');
    assert.equal(dirAfter('cd Program Files', 'cmd', C), win32.join(C, 'Program Files'));
    assert.equal(dirAfter('cd', 'cmd', C), C);
    assert.equal(dirAfter('pushd', 'cmd', C), C);
  });
});

describe('Location: nested shells and launchers', () => {
  it('gives a nested shell its own copy, and adopts a same-shell script', () => {
    const parent = walk('cd a');
    const child = parent.child();
    assert.equal(child.dir, resolve(CWD, 'a'));
    child.apply([word('cd'), word('b')], 'bash');
    assert.equal(parent.dir, resolve(CWD, 'a'));
    parent.adopt(child);
    assert.equal(parent.dir, resolve(CWD, 'a', 'b'));
  });

  it('moves to the folder a launcher names', () => {
    const location = new Location(CWD, HOME);
    location.moveTo(word('sub'), 'bash');
    assert.equal(location.dir, resolve(CWD, 'sub'));
    location.moveTo(word('$D', true), 'bash');
    assert.equal(location.dir, undefined);
  });
});

describe('Location: Git Bash drive paths', () => {
  const onWindows = (line: string): string | undefined => walk(line, 'bash', new Location('C:\\work', 'C:/u')).dir;

  it('reads cd and pushd to /c/x as C:\\x on a host whose home names a drive', () => {
    assert.equal(onWindows('cd /c/x'), 'C:\\x');
    assert.equal(onWindows('cd /d/repo/sub && git status'), 'D:\\repo\\sub');
    assert.equal(onWindows('pushd /c/x'), 'C:\\x');
  });

  it('reads a launcher folder the same way in bash, and leaves a POSIX host and PowerShell as they were', () => {
    const location = new Location('C:\\work', 'C:/u');
    location.moveTo(word('/c/x'), 'bash');
    assert.equal(location.dir, 'C:\\x');
    assert.equal(walk('cd /c/x', 'bash', new Location(CWD, HOME, posix)).dir, '/c/x');
    assert.equal(walk('cd /c/x', 'powershell', new Location('C:\\work', 'C:/u')).dir, 'C:\\c\\x');
  });
});
