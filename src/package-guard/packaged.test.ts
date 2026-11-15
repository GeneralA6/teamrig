import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { programName, SPAWN_SHELL } from '../push-guard/launchers.ts';
import { parseShell } from '../push-guard/tokenizer.ts';
import { PACKAGE_STARTERS, packagedStartOf } from './packaged.ts';

/** What the one command of `line` starts besides itself: `words: a b`, `script: a b`, or `-` for nothing. */
function startOf(line: string): string {
  const [command] = parseShell(line, 'bash').commands;
  const [program, ...args] = command?.words ?? [];
  const start = program === undefined ? undefined : packagedStartOf(programName(program.text), args);
  if (start === undefined) {
    return '-';
  }
  if (start.kind === 'script') {
    assert.equal(start.dialect, SPAWN_SHELL);
    return `script: ${start.script.dynamic ? '<dynamic> ' : ''}${start.script.text}`;
  }
  return `words: ${start.words.map((word) => (word.dynamic ? '<dynamic>' : word.text)).join(' ')}`;
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
