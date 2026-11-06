import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { isAssignment, isShell, launch, programName, staticWord, type Launch } from './launchers.ts';
import { parseShell, type ShellDialect, type ShellWord } from './tokenizer.ts';

const show = (word: ShellWord): string => (word.dynamic ? `~${word.text}` : word.text);

/** A launch as one line: its kind, what it runs, then ` env=`, ` cd=` and ` stdin` when set. */
function summary(launched: Launch): string {
  switch (launched.kind) {
    case 'nothing':
      return 'nothing';
    case 'opaque':
      return `opaque${launched.gated ? '' : '!'}: ${launched.reason}`;
    case 'program':
    case 'script': {
      const head = launched.kind === 'program' ? `program ${[launched.program, ...launched.args].map(show).join(' ')}` : `script(${launched.dialect}${launched.sameShell ? ', same' : ''}) ${show(launched.script)}`;
      const env = launched.env.length === 0 ? '' : ` env=${launched.env.map((assignment) => `${assignment.name}=${show(assignment.value)}`).join(',')}`;
      const chdirs = launched.chdirs.length === 0 ? '' : ` cd=${launched.chdirs.map(show).join(',')}`;
      const stdin = launched.kind === 'program' && launched.stdinArgs ? ' stdin' : '';
      return `${head}${env}${chdirs}${stdin}`;
    }
  }
}

/** What the first command of `line` launches. */
function of(line: string, dialect: ShellDialect = 'bash'): string {
  return summary(launch(parseShell(line, dialect).commands[0]?.words ?? [], dialect));
}

function expectLaunches(rows: readonly (readonly [string, string])[], dialect: ShellDialect = 'bash'): void {
  for (const [line, expected] of rows) {
    assert.equal(of(line, dialect), expected, line);
  }
}

const STDIN = 'opaque: a shell reads its commands from stdin';
const UNKNOWN_PROGRAM = 'opaque: the program it runs is only known when it runs';

describe('programName, isAssignment and staticWord', () => {
  it('names a program by its lower-case file name without an executable extension', () => {
    assert.equal(programName('C:\\Program Files\\Git\\cmd\\GIT.EXE'), 'git');
    assert.equal(programName('/usr/bin/git'), 'git');
    assert.equal(programName('git.cmd'), 'git');
    assert.equal(programName('gitk'), 'gitk');
  });

  it('knows a shell by its program name', () => {
    assert.deepEqual(['bash', '/bin/sh', 'pwsh', 'C:\\Windows\\PowerShell.EXE', 'git', ''].map(isShell), [true, true, true, true, false, false]);
  });

  it('knows the assignments', () => {
    assert.deepEqual(['A=1', '_b=', '1A=1', '=x', 'a-b=1'].map(isAssignment), [true, true, false, false, false]);
    assert.deepEqual(staticWord('x'), { text: 'x', dynamic: false });
  });
});

describe('launch: a shell given its commands on stdin by the line', () => {
  const body = staticWord('git push origin main');
  const given = (line: string): string => summary(launch(parseShell(line, 'bash').commands[0]?.words ?? [], 'bash', body));

  it('runs the heredoc or here-string as a script in a shell of its own', () => {
    assert.deepEqual(['bash', 'bash -s x', 'sh -'].map(given), new Array<string>(3).fill('script(bash) git push origin main'));
    assert.deepEqual(['pwsh', 'pwsh -NoProfile', 'pwsh -Command -', 'powershell -File -'].map(given), new Array<string>(4).fill('script(powershell) git push origin main'));
    assert.deepEqual(['cmd', 'cmd /q'].map(given), new Array<string>(2).fill('script(cmd) git push origin main'));
  });

  it('keeps it opaque under xargs, and ignores it for a script file or a command line', () => {
    assert.equal(given('xargs bash'), STDIN);
    assert.equal(given('bash script.sh'), 'nothing');
    assert.equal(given('bash -c "echo"'), 'script(bash) echo');
    assert.equal(given('git'), 'program git');
  });
});

describe('launch: programs and wrappers', () => {
  it('reads nothing from an empty command', () => {
    assert.equal(summary(launch([], 'bash')), 'nothing');
  });

  it('collects variable prefixes', () => {
    expectLaunches([
      ['git push origin main', 'program git push origin main'],
      ['A=1 B=$x git push', 'program git push env=A=1,B=~$x'],
    ]);
  });

  it('reads env: folders, assignments and split strings', () => {
    expectLaunches([
      ['env -C /tmp -u X A=1 git push', 'program git push env=A=1 cd=/tmp'],
      ['env --chdir=/tmp git push', 'program git push cd=/tmp'],
      ["env -S 'git push origin main'", 'program git push origin main'],
      ["env --split-string='git push' -x", 'program git push -x'],
      ['env -S "$X"', 'opaque: env -S splits a command line only known when it runs'],
    ]);
  });

  it('runs nothing under an inspecting option', () => {
    expectLaunches([
      ['command -v git', 'nothing'],
      ['command -pv git push', 'nothing'],
      ['command git push', 'program git push'],
      ['sudo -l', 'nothing'],
      ['sudo --list git push', 'nothing'],
    ]);
  });

  it('reads the options of sudo, timeout, nice, xargs, wsl, exec, nohup and time', () => {
    expectLaunches([
      ['sudo -u me -D /srv git push', 'program git push cd=/srv'],
      ['sudo --user=me HOME=/x git push', 'program git push env=HOME=/x'],
      ['timeout -s KILL 10 git push', 'program git push'],
      ['timeout --signal=KILL 10 git push', 'program git push'],
      ['nice -n5 git push', 'program git push'],
      ['xargs -n 1 git push', 'program git push stdin'],
      ['wsl --cd /x git push', 'program git push cd=/x'],
      ['exec -a name git push', 'program git push'],
      ['nohup -- git push', 'program git push'],
      ['time', 'nothing'],
    ]);
  });

  it('stops reading wrappers that nest too deep', () => {
    assert.equal(of(`${'nohup '.repeat(16)}git push`), 'opaque: wrappers nest too deep to read');
    assert.equal(of(`${'nohup '.repeat(15)}git push`), 'program git push');
  });

  it('marks a program only known when it runs', () => {
    assert.equal(of('$GIT push'), UNKNOWN_PROGRAM);
    assert.equal(of('& $git push', 'powershell'), UNKNOWN_PROGRAM);
  });

  it('keeps the command from a program word only known when it runs, so a guard can still read its arguments', () => {
    const launched = launch(parseShell('$T exec approve R1', 'bash').commands[0]?.words ?? [], 'bash');
    assert.ok(launched.kind === 'opaque' && launched.command !== undefined);
    assert.equal(launched.command.program.dynamic, true);
    assert.deepEqual(launched.command.args.map(show), ['exec', 'approve', 'R1']);
    const deep = launch(parseShell(`${'nohup '.repeat(16)}git push`, 'bash').commands[0]?.words ?? [], 'bash');
    assert.equal(deep.kind === 'opaque' ? deep.command : 'not opaque', undefined);
  });

  it('keeps the command of a teamrig call whose subcommand is only known when it runs, so the exec guard can refuse it', () => {
    for (const [line, dialect] of [
      ['teamrig "$G" approve R1', 'bash'],
      ['teamrig $G approve R1', 'powershell'],
    ] as const) {
      const launched = launch(parseShell(line, dialect).commands[0]?.words ?? [], dialect);
      assert.equal(summary(launched), 'opaque: the teamrig subcommand it runs is only known when it runs', line);
      assert.ok(launched.kind === 'opaque' && launched.command !== undefined, line);
      assert.equal(show(launched.command.program), 'teamrig', line);
      assert.deepEqual(launched.command.args.map(show), ['~$G', 'approve', 'R1'], line);
    }
  });
});

describe('launch: keywords', () => {
  it('skips bash keywords and reads data lines as nothing', () => {
    expectLaunches([
      ['if git push', 'program git push'],
      ['! git push', 'program git push'],
      ['coproc git push', 'program git push'],
      ['for x in git push', 'nothing'],
      ['function deploy', 'nothing'],
    ]);
  });

  it('skips PowerShell keywords in any case', () => {
    expectLaunches(
      [
        ['If git push', 'program git push'],
        ['foreach git push', 'nothing'],
        ['Function Deploy', 'nothing'],
      ],
      'powershell',
    );
  });

  it("reads cmd's if forms, else and data lines", () => {
    expectLaunches(
      [
        ['if exist x git push', 'program git push'],
        ['if /i not a==b git push', 'program git push'],
        ['if a== b git push', 'program git push'],
        ['if a ==b git push', 'program git push'],
        ['if %x% EQU 1 git push', 'program git push'],
        ['if foo git push', 'nothing'],
        ['else git push', 'program git push'],
        ['rem git push', 'nothing'],
        ['set X=1', 'nothing'],
      ],
      'cmd',
    );
  });
});

describe('launch: PowerShell expressions and launchers', () => {
  /** What each command of `line` launches, for a line whose program sits inside a block. */
  const launchesOf = (line: string): string[] => parseShell(line, 'powershell').commands.map((command) => summary(launch(command.words, 'powershell')));

  /** For a line whose head or argument holds a group: the group's commands are listed first, the line's own comes last. */
  const expectLastLaunches = (rows: readonly (readonly [string, string])[]): void => {
    for (const [line, expected] of rows) {
      assert.equal(launchesOf(line).at(-1), expected, line);
    }
  };

  it('runs the right side of an assignment and skips casts', () => {
    expectLaunches(
      [
        ['$x = git push', 'program git push'],
        ['$x=git push', 'program git push'],
        ['[void]$x', 'nothing'],
        ['$x + 1', 'nothing'],
        ['& git push', 'program git push'],
        ['. git push', 'program git push'],
      ],
      'powershell',
    );
  });

  it('reads any assignment target, and no other word, as an assignment', () => {
    expectLaunches(
      [
        ['$h.a = git push', 'program git push'],
        ['$h.a=git push', 'program git push'],
        ['$w[0] = git push', 'program git push'],
        ['$w[0]=git push', 'program git push'],
        ['$w[$a[0]]=git push', 'program git push'],
        ['$w[$i=0]=git push', 'program git push'],
        ['${a=b} = git push', 'program git push'],
        ['$p,$q = git push', 'program git push'],
        ['$p,$q=git push', 'program git push'],
        ['$x ??= git push', 'program git push'],
        ['$a = $b = git push', 'program git push'],
        ['[int]$h.a = git push', 'program git push'],
        ['$x -eq 1', 'nothing'],
        ['$p,$q', 'nothing'],
        ['$p,b=git', 'nothing'],
        ['git commit -m x = y', 'program git commit -m x = y'],
        ["'x'.y = git push", 'program git push'],
        ['"x".y = git push', 'program git push'],
        ['[Console]::Title = git push', 'program git push'],
        ['[int]::y = git push', 'program git push'],
        ['$env:X = git push', 'program git push'],
        ['[int]$x = git push', 'program git push'],
        ['$x = & git push', 'program git push'],
        ['$x = . git push', 'program git push'],
      ],
      'powershell',
    );
    expectLastLaunches([
      ['(1).y = git push', 'program git push'],
      ['$(1).y = git push', 'program git push'],
      ['@(1).y = git push', 'program git push'],
      ['(1)[0] = git push', 'program git push'],
      ['@{a=1}.a = git push', 'program git push'],
      ['{x}.y = git push', 'program git push'],
    ]);
  });

  it('keeps a word only a quote or a path makes a program a program, whatever follows', () => {
    expectLaunches(
      [
        // 5.1 refuses this line when it parses it, so nothing runs: the guard reading a program is the stricter side.
        ["'$x' = git push", 'program $x = git push'],
        ['.\\x.ps1 = git push', 'program .\\x.ps1 = git push'],
      ],
      'powershell',
    );
    expectLastLaunches([['.\\x.ps1 (git push)', 'program .\\x.ps1 ~(git push)']]);
  });

  it('calls an expression head nothing unless `&` makes it a program', () => {
    expectLaunches(
      [
        ['[int]::y', 'nothing'],
        ['"x".y', 'nothing'],
      ],
      'powershell',
    );
    expectLastLaunches([['(1).y', 'nothing']]);
    assert.equal(of('& "x".y', 'powershell'), UNKNOWN_PROGRAM);
  });

  it('lists the commands of a block called at once with no opaque ask, and leaves a called value opaque', () => {
    assert.ok(launchesOf('& { git push }').includes('program git push'));
    assert.ok(!launchesOf('& { git push }').some((launched) => launched.startsWith('opaque')));
    assert.ok(launchesOf('. { git push }').includes('program git push'));
    assert.ok(launchesOf('& (Get-Command git) push').includes(UNKNOWN_PROGRAM));
  });

  it('lists a block handed to a command, or to the shell it starts', () => {
    for (const line of ['Invoke-Command { git push }', '% { git push }', 'ForEach-Object { git push }', 'Invoke-Command -ScriptBlock { git push }', 'powershell -Command { git push }']) {
      assert.ok(launchesOf(line).includes('program git push'), line);
    }
  });

  it('reads Invoke-Expression and Start-Process', () => {
    expectLaunches(
      [
        ["iex 'git push'", 'script(powershell, same) git push'],
        ["Invoke-Expression -Command 'git push'", 'script(powershell, same) git push'],
        ['iex', STDIN],
        ['Invoke-Expression -Verbose', STDIN],
        ["Start-Process -FilePath git -WorkingDirectory C:\\x -ArgumentList 'push origin main' -Wait", 'program git push origin main cd=C:\\x'],
        ['saps -NoNewWindow git push', 'program git push'],
        ['Start-Process -Verb RunAs git', 'program git'],
        ['start git push', 'program git push'],
        ['Start-Process', 'nothing'],
      ],
      'powershell',
    );
  });
});

describe('launch: shells handed a command line', () => {
  it('reads POSIX shells', () => {
    expectLaunches([
      ["bash -c 'git push'", 'script(bash) git push'],
      ["bash -lc 'git push'", 'script(bash) git push'],
      ["bash -o pipefail -c 'git push'", 'script(bash) git push'],
      ["bash --norc -c 'git push'", 'script(bash) git push'],
      ['bash -c', 'nothing'],
      ['bash script.sh', 'nothing'],
      ['bash -- script.sh', 'nothing'],
      ['bash', STDIN],
      ['bash -s', STDIN],
    ]);
  });

  it('reads pwsh and powershell options, abbreviations and encoded commands', () => {
    const encoded = Buffer.from('git push origin main', 'utf16le').toString('base64');
    expectLaunches([
      ['pwsh -NoProfile -Command git push', 'script(powershell) git push'],
      ["pwsh --command 'git push'", 'script(powershell) git push'],
      ["pwsh /c 'git push'", 'script(powershell) git push'],
      ["pwsh -cwa 'git push'", 'script(powershell) git push'],
      ["pwsh -ExecutionPolicy Bypass -c 'git push'", 'script(powershell) git push'],
      ["pwsh -wd /x -c 'git push'", 'script(powershell) git push cd=/x'],
      ['powershell git push', 'script(powershell) git push'],
      [`pwsh -EncodedCommand ${encoded}`, 'script(powershell) git push origin main'],
      ['pwsh -enc $x', 'opaque!: an encoded PowerShell command cannot be read'],
      ["pwsh -e 'not base64!'", 'opaque!: an encoded PowerShell command cannot be read'],
      ['pwsh -ec', 'nothing'],
      ['pwsh -Command', 'nothing'],
      ['pwsh -File x.ps1', 'nothing'],
      ['pwsh script.ps1', 'nothing'],
      ['pwsh -c -', STDIN],
      ['pwsh -File -', STDIN],
      ['pwsh -', STDIN],
      ['pwsh -NoProfile', STDIN],
    ]);
  });

  it('reads cmd /c and /k, quoting words with spaces', () => {
    expectLaunches([
      ['cmd /c git push', 'script(cmd) git push'],
      ['cmd //c git push', 'script(cmd) git push'],
      ['cmd /cgit push', 'script(cmd) git push'],
      ['cmd /k git push', 'script(cmd) git push'],
      ['cmd /q /c git commit -m "a b"', 'script(cmd) git commit -m "a b"'],
      ['cmd /c', 'nothing'],
      ['cmd', STDIN],
      ['cmd x', STDIN],
    ]);
  });

  it('reads eval in bash only', () => {
    expectLaunches([
      ['eval git push', 'script(bash, same) git push'],
      ['eval', 'nothing'],
    ]);
    assert.equal(of('eval x', 'powershell'), 'program eval x');
  });

  it("reads cmd's start: the title, the folder and its options", () => {
    expectLaunches(
      [
        ['start "" git push', 'program git push'],
        ['start "my title" /d C:\\x git push', 'program git push cd=C:\\x'],
        ['start /dC:\\x git push', 'program git push cd=C:\\x'],
        ['start /b /node 1 git push', 'program git push'],
        ['start git push', 'program git push'],
      ],
      'cmd',
    );
    assert.equal(of('start git push'), 'program git push');
  });
});
