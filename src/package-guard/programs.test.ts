import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import type { ShellDialect } from '../push-guard/tokenizer.ts';
import { DASH_QUOTES, NOTHING_QUOTES } from '../testing/ansi-c-quotes.ts';
import { programsOf, runsOf, type BareCommand, type ProgramRun } from './programs.ts';

const APP = resolve('/', 'work', 'app');
const HOME = resolve('/', 'u');

/** Each program the line starts, as `name args @ dir`, with `?` for a folder only known when it runs. */
function runs(command: string, dialect: ShellDialect = 'bash'): string[] {
  return programsOf(command, { cwd: APP, home: HOME, dialect }).map(
    (run) => `${[run.name, ...run.args.map((arg) => arg.text)].join(' ')} @ ${run.dir ?? '?'}`,
  );
}

describe('programsOf', () => {
  it('names each program a line starts, with its arguments and folder', () => {
    assert.deepEqual(runs('npx eslint . && git status'), [`npx eslint . @ ${APP}`, `git status @ ${APP}`]);
    assert.deepEqual(runs('C:/nodejs/npx.cmd tsc'), [`npx tsc @ ${APP}`]);
  });

  it('follows cd, keeps a subshell cd inside its subshell, and loses a folder only known when it runs', () => {
    assert.deepEqual(runs('cd sub && npx tsc'), [`npx tsc @ ${join(APP, 'sub')}`]);
    assert.deepEqual(runs('(cd sub; npx a); npx b'), [`npx a @ ${join(APP, 'sub')}`, `npx b @ ${APP}`]);
    assert.deepEqual(runs('cd "$D" && npx a'), ['npx a @ ?']);
  });

  it('reads through launchers and nested shells, a launcher folder included', () => {
    assert.deepEqual(runs('bash -c "pnpm dlx cowsay"'), [`pnpm dlx cowsay @ ${APP}`]);
    assert.deepEqual(runs('env -C sub npx x'), [`npx x @ ${join(APP, 'sub')}`]);
    assert.deepEqual(runs("env -C sub bash -c 'npx x'"), [`npx x @ ${join(APP, 'sub')}`]);
    assert.deepEqual(runs('eval "cd sub"; npx x'), [`npx x @ ${join(APP, 'sub')}`]);
  });

  it("reads a program, a launcher or its option behind a $'...' string whose value is nothing", () => {
    const sub = join(APP, 'sub');
    for (const quote of NOTHING_QUOTES) {
      assert.deepEqual(runs(`${quote}npx cowsay`), [`npx cowsay @ ${APP}`], quote);
      assert.deepEqual(runs(`npx ${quote}cowsay`), [`npx cowsay @ ${APP}`], quote);
      assert.deepEqual(runs(`env ${quote}-C sub npx x`), [`npx x @ ${sub}`], quote);
      assert.deepEqual(runs(`${quote}env -C sub npx x`), [`npx x @ ${sub}`], quote);
      assert.deepEqual(runs(`bash ${quote}-c 'npx x'`), [`npx x @ ${APP}`], quote);
      assert.deepEqual(runs(`${quote}bash -c 'npx x'`), [`npx x @ ${APP}`], quote);
      assert.deepEqual(runs(`${quote}eval 'npx x'`), [`npx x @ ${APP}`], quote);
      assert.deepEqual(runs(`${quote}cd sub && npx a`), [`npx a @ ${sub}`], quote);
    }
  });

  it('reads a launcher option whose dash only bash spells out', () => {
    for (const dash of DASH_QUOTES) {
      assert.deepEqual(runs(`sh ${dash}c 'npx x'`), [`npx x @ ${APP}`], dash);
      assert.deepEqual(runs(`env ${dash}C sub npx x`), [`npx x @ ${join(APP, 'sub')}`], dash);
    }
  });

  it('reads a script a plain cat pipes into a shell', () => {
    assert.deepEqual(
      runs('cat <<EOF | bash\nnpx x\nEOF').filter((run) => run.startsWith('npx')),
      [`npx x @ ${APP}`],
    );
  });

  it('reads PowerShell and its Set-Location', () => {
    assert.deepEqual(runs('Set-Location sub; npx.cmd eslint', 'powershell'), [`npx eslint @ ${join(APP, 'sub')}`]);
  });

  it('marks a program that reads a pipe, and keeps its redirections', () => {
    const piped = (command: string, dialect: ShellDialect = 'bash'): string[] =>
      programsOf(command, { cwd: undefined, home: HOME, dialect }).map((run) => `${run.name}${run.piped ? ' piped' : ''}`);
    assert.deepEqual(piped('git log | grep x && grep -rn y src'), ['git', 'grep piped', 'grep']);
    assert.deepEqual(piped('(git log) | grep x || grep y'), ['git', 'grep piped', 'grep']);
    assert.deepEqual(piped('a $(b | c) | d'), ['b', 'c piped', 'a', 'd piped']);
    assert.deepEqual(piped('Get-Content x | Select-String y', 'powershell'), ['get-content', 'select-string piped']);
    const [cat] = programsOf('cat <<EOF > out.txt\nhi\nEOF', { cwd: APP, home: HOME, dialect: 'bash' });
    assert.deepEqual(
      cat?.redirections.map((redirection) => `${redirection.operator} ${redirection.target?.text ?? ''}`),
      ['<< EOF', '> out.txt'],
    );
  });

  it('marks what a teamrig runner starts, at any depth, and nothing after it on the line', () => {
    const marked = (command: string): string[] =>
      programsOf(command, { cwd: APP, home: HOME, dialect: 'bash' }).map((run) => `${run.name}${run.runner ? ' runner' : ''}`);
    assert.deepEqual(marked('npm test'), ['npm']);
    assert.deepEqual(marked('teamrig queue --what x -- npm test && npm run build'), ['npm runner', 'npm']);
    assert.deepEqual(marked('teamrig queue --what x -- "tsc && bash -c \'node --test\'"'), ['tsc runner', 'node runner']);
    assert.deepEqual(marked('teamrig test -- teamrig queue --what x -- npx jest'), ['npx runner']);
    assert.deepEqual(marked('teamrig start --session a; teamrig queue --what x'), ['teamrig', 'teamrig']);
  });

  it('runs the command teamrig queue and teamrig test start after their --', () => {
    assert.deepEqual(runs('teamrig queue --session a --what "x y" -- npx tsc -p .'), [`npx tsc -p . @ ${APP}`]);
    assert.deepEqual(runs('teamrig test -- teamrig queue --what x -- npx jest'), [`npx jest @ ${APP}`]);
    assert.deepEqual(runs('teamrig queue --what x -- "npx eslint ."'), [`npx eslint . @ ${APP}`]);
    assert.deepEqual(runs('teamrig add --description "teamrig queue -- npx x"'), [`teamrig add --description teamrig queue -- npx x @ ${APP}`]);
    assert.deepEqual(runs('teamrig queue --what x --'), []);
    assert.deepEqual(runs('teamrig $SUB -- npx x'), []);
  });

  it('still runs the command teamrig heavy, the old name of queue, starts after its --', () => {
    assert.deepEqual(runs('teamrig heavy --what x -- npx tsc -p .'), [`npx tsc -p . @ ${APP}`]);
  });

  it('names a program under the home folder that $HOME or a leading ~ in a value names', () => {
    assert.deepEqual(runs('N=~/bin/npx; $N eslint'), [`npx eslint @ ${APP}`]);
    assert.deepEqual(runs('$HOME/bin/npx eslint'), [`npx eslint @ ${APP}`]);
  });

  it('names no program only known when the line runs, and stops at a script nested too deep', () => {
    assert.deepEqual(runs('$RUNNER eslint'), []);
    const nested = Array.from({ length: 10 }).reduce<string>((line) => `bash -c ${JSON.stringify(line)}`, 'npx deep');
    assert.deepEqual(runs(nested), []);
  });
});

describe('runsOf', () => {
  const context = (dialect: ShellDialect) => ({ cwd: APP, home: HOME, dialect });

  it('keeps each command that starts no program: a bare env, a PowerShell expression', () => {
    const bare = (command: string, dialect: ShellDialect = 'bash'): string[] =>
      runsOf(command, context(dialect)).bare.map((run) => `${run.dialect}: ${run.words.map((word) => word.text).join(' ')}`);
    assert.deepEqual(bare('env -i && env X=1 node a.js'), ['bash: env -i']);
    assert.deepEqual(bare('$env:HOME; Get-Date', 'powershell'), ['powershell: $env:HOME']);
    assert.deepEqual(bare('bash -c "env"'), ['bash: env']);
    assert.deepEqual(bare('cd sub && git status'), []);
  });

  it('keeps each program word as the line writes it, after its literal variables', () => {
    const words = (command: string): string[] => runsOf(command, context('bash')).programs.map((run) => `${run.name}: ${run.program.text}`);
    assert.deepEqual(words('C:/nodejs/npx.cmd tsc && teamrig list'), ['npx: C:/nodejs/npx.cmd', 'teamrig: teamrig']);
    assert.deepEqual(words('T=/opt/kit/bin/teamrig; $T exec status R1'), ['teamrig: /opt/kit/bin/teamrig']);
  });

  it('keeps each command whose program is only known when it runs, with its arguments and dialect, and no other', () => {
    const opaque = (command: string, dialect: ShellDialect = 'bash'): string[] =>
      runsOf(command, context(dialect)).opaque.map((run) => `${run.dialect}: ${[run.program.text, ...run.args.map((arg) => arg.text)].join(' ')}`);
    assert.deepEqual(opaque('$T exec approve R1 && git status'), ['bash: $T exec approve R1']);
    assert.deepEqual(opaque('bash -c "$RUNNER eslint ."'), ['bash: $RUNNER eslint .']);
    assert.deepEqual(opaque('teamrig "$G" approve R1'), ['bash: teamrig $G approve R1']);
    assert.deepEqual(opaque('teamrig $G approve R1', 'powershell'), ['powershell: teamrig $G approve R1']);
    assert.deepEqual(opaque('T=/opt/kit/bin/teamrig; $T exec status R1'), []);
    assert.deepEqual(opaque('teamrig exec status R1'), []);
  });

  it('gives each program the dialect of the script that starts it', () => {
    const dialects = runsOf('cat a; pwsh -Command "Get-Content b"', context('bash')).programs.map((run) => `${run.name} ${run.dialect}`);
    assert.deepEqual(dialects, ['cat bash', 'get-content powershell']);
  });

  it('names the program a command pipes its output into, unknown when the line cannot tell', () => {
    const into = (command: string): string[] =>
      runsOf(command, context('bash')).programs.map((run) => `${run.name}${run.pipe === undefined ? '' : ` | ${run.pipe.into?.name ?? '?'}`}`);
    assert.deepEqual(into('echo "$T" | docker login --password-stdin'), ['echo | docker', 'docker']);
    assert.deepEqual(into('a | $X; b | c | d'), ['a | ?', 'b | c', 'c | d', 'd']);
    assert.deepEqual(into('a $(b | c) | d'), ['b | c', 'c', 'a | d', 'd']);
    assert.deepEqual(into('a | bash -c "b"'), ['a | ?', 'b']);
    const [bare] = runsOf('$env:T | docker login --password-stdin > out.txt', context('powershell')).bare;
    assert.equal(bare?.pipe?.into?.name, 'docker');
    assert.deepEqual(runsOf('$env:T > out.txt', context('powershell')).bare[0]?.redirections.map((redirection) => redirection.operator), ['>']);
  });

  it('sends the output of a launched script on through the pipe of the command that launches it', () => {
    const into = (command: string): string[] =>
      runsOf(command, context('bash')).programs.map((run) => `${run.name}${run.pipe === undefined ? '' : ` | ${run.pipe.into?.name ?? '?'}`}`);
    assert.deepEqual(into('bash -c "a | b; c" | wc -c'), ['a | b', 'b | wc', 'c | wc', 'wc']);
  });

  it('gives a pipe after a PowerShell group to the command holding the group, or to the command the group starts', () => {
    const into = (command: string): string[] =>
      runsOf(command, context('powershell')).programs.map((run) => `${run.name}${run.pipe === undefined ? '' : ` | ${run.pipe.into?.name ?? '?'}`}`);
    // An argument's group runs before the command holding it, measured on 5.1.
    assert.deepEqual(into('Get-Item (Join-Path a b) | Set-Clipboard'), ['join-path', 'get-item | set-clipboard', 'set-clipboard']);
    assert.deepEqual(into('(Get-Content a) | Set-Clipboard'), ['get-content | set-clipboard', 'set-clipboard']);
    assert.deepEqual(into('Write-Output (Get-Item (Join-Path a b) | Select-Object x) | Set-Clipboard'), [
      'join-path',
      'get-item | select-object',
      'select-object',
      'write-output | set-clipboard',
      'set-clipboard',
    ]);
  });

  it('names the command whose value a substitution or a PowerShell group gives its output to', () => {
    const named = (command: ProgramRun | BareCommand | undefined): string =>
      command === undefined ? '?' : 'name' in command ? command.name : command.words.map((word) => word.text).join(' ');
    const holders = (command: string, dialect: ShellDialect): string[] => {
      const runs = runsOf(command, context(dialect));
      return [...runs.programs, ...runs.bare].map((run) => `${named(run)}${run.substitution === undefined ? '' : ` in ${named(run.substitution.holder)}`}`);
    };
    assert.deepEqual(holders('curl -H "A: $(cat t | tr -d x)" u; X=$(cat .env)', 'bash'), ['cat in curl', 'tr in curl', 'curl', 'cat in X=$(cat .env)', 'X=$(cat .env)']);
    assert.deepEqual(holders('echo $(echo `cat f`) | wc -c; X=$(bash -c "cat g")', 'bash'), [
      'cat in echo',
      'echo in echo',
      'echo',
      'wc',
      'cat in X=$(bash -c "cat g")',
      'X=$(bash -c "cat g")',
    ]);
    assert.deepEqual(holders('$v = (Get-Content f); Write-Output (Get-Content g); if ($env:T) { gc h }', 'powershell'), [
      'get-content in $v =',
      'get-content in write-output',
      'write-output',
      'gc',
      '$v =',
      'if',
      '$env:T in if',
    ]);
    assert.deepEqual(holders('$X $(cat f)', 'bash'), ['cat in ?']);
  });

  it('marks a program whose output a PowerShell assignment takes', () => {
    const captured = (command: string): boolean[] => runsOf(command, context('powershell')).programs.map((run) => run.captured);
    assert.deepEqual(captured('$c = Get-Content a; $n=Get-Content b; Get-Content c'), [true, true, false]);
  });

  it('gives a program the body it reads on stdin from the line, a piped one too', () => {
    const bodies = (command: string): (string | undefined)[] => runsOf(command, context('bash')).programs.map((run) => run.stdin?.text);
    assert.deepEqual(bodies("node <<'EOF'\nconsole.log(1)\nEOF"), ['console.log(1)']);
    assert.deepEqual(bodies('python3 <<< "print(2)"'), ['print(2)']);
    assert.deepEqual(bodies('cat <<EOF | node\nx()\nEOF'), ['x()', 'x()']);
    assert.deepEqual(bodies('node a.js'), [undefined]);
  });
});
