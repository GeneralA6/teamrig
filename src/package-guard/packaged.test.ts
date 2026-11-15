import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { launch, programName } from '../push-guard/launchers.ts';
import { parseShell } from '../push-guard/tokenizer.ts';
import type { ShellWord } from '../push-guard/tokenizer.ts';
import { PACKAGE_STARTERS, packagedStartOf, type PackagedStart } from './packaged.ts';

function textOf(word: ShellWord): string {
  return word.dynamic ? `<dynamic> ${word.text}`.trimEnd() : word.text;
}

function render(start: PackagedStart): string {
  switch (start.kind) {
    case 'words':
      return `words: ${start.words.map((word) => (word.dynamic ? '<dynamic>' : word.text)).join(' ')}`;
    case 'script':
      return `script: ${textOf(start.script)}`;
    case 'foreign-shell':
      return `foreign ${textOf(start.shell)}: ${textOf(start.script)}`;
  }
}

/**
 * What the one command of `line` starts besides itself, each distinct reading joined by ` | `: `words: a b`,
 * `script: a b` (read in every dialect, which it checks), `foreign <shell>: a b`, or `-` for nothing.
 */
function startOf(line: string): string {
  const [command] = parseShell(line, 'bash').commands;
  const launched = command === undefined ? undefined : launch(command.words, 'bash', undefined);
  const starts = launched?.kind === 'program' ? packagedStartOf(programName(launched.program.text), launched.args, launched.env) : [];
  if (starts.length === 0) {
    return '-';
  }
  const scripts = starts.flatMap((start) => (start.kind === 'script' ? [start] : []));
  for (const text of new Set(scripts.map(({ script }) => script.text))) {
    const dialects = scripts.filter(({ script }) => script.text === text).map(({ dialect }) => dialect);
    assert.deepEqual([...dialects].sort(), ['bash', 'cmd', 'powershell'], line);
  }
  return [...new Set(starts.map(render))].join(' | ');
}

describe('packagedStartOf (T3069)', () => {
  it("reads npx, bunx, npm exec and bun x: the operand after the options, or the shell line of -c and --call", () => {
    assert.equal(startOf('npx bash -c "teamrig exec approve R1"'), 'words: bash -c teamrig exec approve R1');
    assert.equal(startOf('npx --yes -p acme teamrig status'), 'words: teamrig status');
    assert.equal(startOf('npx -- teamrig status'), 'words: teamrig status');
    assert.equal(startOf('npx -c "teamrig exec approve R1"'), 'script: teamrig exec approve R1');
    assert.equal(startOf('npx --call="teamrig exec approve R1"'), 'script: teamrig exec approve R1');
    assert.equal(startOf('npm exec --call "teamrig status"'), 'script: teamrig status');
    assert.equal(startOf('npm --prefix app x -c "teamrig status"'), 'script: teamrig status');
    assert.equal(startOf('bunx bash -c "teamrig status"'), 'words: bash -c teamrig status');
    assert.equal(startOf('bun x teamrig status'), 'words: teamrig status');
    assert.equal(startOf('npx "$P" status'), 'words: <dynamic> status');
  });

  it("reads pnpm exec, pnpm dlx and pnpx, joining the words a shell mode hands its shell", () => {
    assert.equal(startOf('pnpm exec sh -c "teamrig status"'), 'words: sh -c teamrig status');
    assert.equal(startOf('pnpm -C app exec teamrig status'), 'words: teamrig status');
    assert.equal(startOf('pnpm exec -c teamrig status'), 'script: teamrig status');
    assert.equal(startOf('pnpm dlx -c "teamrig status"'), 'script: teamrig status');
    assert.equal(startOf('pnpm dlx -p acme teamrig status'), 'words: teamrig status');
    assert.equal(startOf('pnpx --shell-mode teamrig "$S"'), 'script: <dynamic> teamrig $S');
  });

  it('reads yarn exec and yarn dlx, and a shell a bare pnpm, yarn or bun form starts', () => {
    assert.equal(startOf('yarn exec bash -c "teamrig status"'), 'words: bash -c teamrig status');
    assert.equal(startOf('yarn --cwd app dlx -p acme teamrig status'), 'words: teamrig status');
    assert.equal(startOf('pnpm sh -c "teamrig status"'), 'words: sh -c teamrig status');
    assert.equal(startOf('yarn run bash -c "teamrig status"'), 'words: bash -c teamrig status');
    assert.equal(startOf('bun run --cwd app bash -c "teamrig status"'), 'words: bash -c teamrig status');
  });

  it('reads a shell line a script shell the line names would run, and keeps a named shell no guard reads', () => {
    assert.equal(startOf('npx --script-shell=bash -c "teamrig status"'), 'script: teamrig status');
    assert.equal(startOf('npx --script-shell pwsh -c "teamrig status"'), 'script: teamrig status');
    assert.equal(startOf('npm --script-shell=node exec -c "teamrig status"'), 'script: teamrig status | foreign node: teamrig status');
    assert.equal(startOf('npm_config_script_shell=python3 npx -c "teamrig status"'), 'script: teamrig status | foreign python3: teamrig status');
    assert.equal(startOf('ComSpec=C:/Windows/System32/cmd.exe npx -c "teamrig status"'), 'script: teamrig status');
    assert.equal(startOf('ComSpec=C:/tools/run.exe pnpm exec -c teamrig status'), 'script: teamrig status | foreign C:/tools/run.exe: teamrig status');
    assert.equal(startOf('npx --script-shell "$S" -c "teamrig status"'), 'script: teamrig status | foreign <dynamic> $S: teamrig status');
    assert.equal(startOf('npx --script-shell=node eslint .'), 'words: eslint .');
  });

  it('reads the first operand of yarn exec and bun exec as a shell line too, as Yarn 2+ and Bun run it in a shell of their own', () => {
    assert.equal(startOf('yarn exec "teamrig exec status R1"'), 'words: teamrig exec status R1 | script: teamrig exec status R1');
    assert.equal(startOf('bun exec "teamrig status && git push"'), 'words: teamrig status && git push | script: teamrig status && git push');
    assert.equal(startOf('bun exec teamrig status'), 'words: teamrig status');
    assert.equal(startOf('yarn exec "$CMD"'), 'words: <dynamic> | script: <dynamic> $CMD');
  });

  it('reads the version managers: corepack, volta run, fnm exec, nvm exec', () => {
    assert.equal(startOf('corepack pnpm@9.1.0 exec teamrig status'), 'words: pnpm exec teamrig status');
    assert.equal(startOf('corepack yarnpkg dlx teamrig'), 'words: yarnpkg dlx teamrig');
    assert.equal(startOf('volta run --node 20 --env A=1 teamrig status'), 'words: teamrig status');
    assert.equal(startOf('fnm --log-level quiet exec --using 20 -- teamrig status'), 'words: teamrig status');
    assert.equal(startOf('nvm exec --silent 20 teamrig status'), 'words: teamrig status');
    assert.equal(startOf('nvm exec lts/iron teamrig status'), 'words: teamrig status');
    assert.equal(startOf('nvm exec teamrig status'), 'words: teamrig status');
  });

  it('starts nothing for a script, an install, a bare bin name or a program that is no runner', () => {
    for (const line of ['npm test', 'npm run build', 'npm install acme', 'pnpm build', 'yarn', 'yarn build', 'bun run build', 'npx', 'corepack enable', 'corepack acme', 'volta install node', 'fnm use 20', 'nvm use 20', 'nvm exec', 'git exec x']) {
      assert.equal(startOf(line), '-', line);
    }
  });

  it('names every program it reads', () => {
    assert.deepEqual([...PACKAGE_STARTERS].sort(), ['bun', 'bunx', 'corepack', 'fnm', 'npm', 'npx', 'nvm', 'pnpm', 'pnpx', 'volta', 'yarn']);
  });
});
