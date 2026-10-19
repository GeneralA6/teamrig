import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import type { ShellDialect } from '../push-guard/tokenizer.ts';
import { programsOf } from './programs.ts';

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
    assert.deepEqual(marked('teamrig heavy --what x -- npm test && npm run build'), ['npm runner', 'npm']);
    assert.deepEqual(marked('teamrig heavy --what x -- "tsc && bash -c \'node --test\'"'), ['tsc runner', 'node runner']);
    assert.deepEqual(marked('teamrig test -- teamrig heavy --what x -- npx jest'), ['npx runner']);
    assert.deepEqual(marked('teamrig start --session a; teamrig heavy --what x'), ['teamrig', 'teamrig']);
  });

  it('runs the command teamrig heavy and teamrig test start after their --', () => {
    assert.deepEqual(runs('teamrig heavy --session a --what "x y" -- npx tsc -p .'), [`npx tsc -p . @ ${APP}`]);
    assert.deepEqual(runs('teamrig test -- teamrig heavy --what x -- npx jest'), [`npx jest @ ${APP}`]);
    assert.deepEqual(runs('teamrig heavy --what x -- "npx eslint ."'), [`npx eslint . @ ${APP}`]);
    assert.deepEqual(runs('teamrig add --description "teamrig heavy -- npx x"'), [`teamrig add --description teamrig heavy -- npx x @ ${APP}`]);
    assert.deepEqual(runs('teamrig heavy --what x --'), []);
    assert.deepEqual(runs('teamrig $SUB -- npx x'), []);
  });

  it('names no program only known when the line runs, and stops at a script nested too deep', () => {
    assert.deepEqual(runs('$RUNNER eslint'), []);
    const nested = Array.from({ length: 10 }).reduce<string>((line) => `bash -c ${JSON.stringify(line)}`, 'npx deep');
    assert.deepEqual(runs(nested), []);
  });
});
