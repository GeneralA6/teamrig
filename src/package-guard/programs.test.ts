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

  it('names no program only known when the line runs, and stops at a script nested too deep', () => {
    assert.deepEqual(runs('$RUNNER eslint'), []);
    const nested = Array.from({ length: 10 }).reduce<string>((line) => `bash -c ${JSON.stringify(line)}`, 'npx deep');
    assert.deepEqual(runs(nested), []);
  });
});
