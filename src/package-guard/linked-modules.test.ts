import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FakeWorktreeFiles } from '../testing/fake-worktrees.ts';
import { NODE_WORKTREE_FILES } from '../worktree/files.ts';
import { linkedModulesWritesOf } from './linked-modules.ts';
import type { ProgramsContext } from './programs.ts';

const WORK = resolve('/', 'work');
const APP = join(WORK, 'app');
const MAIN = join(WORK, 'main', 'node_modules');
const HOME = resolve('/', 'u');

/** A worktree at APP whose node_modules is a junction to the main checkout's, as `teamrig worktree add` makes it. */
function linkedTree(): FakeWorktreeFiles {
  return new FakeWorktreeFiles({ [join(APP, 'node_modules')]: { kind: 'link', target: MAIN }, [join(APP, 'sub')]: { kind: 'folder' } });
}

function context(cwd: string | undefined, dialect: ProgramsContext['dialect'] = 'bash'): ProgramsContext {
  return { cwd, home: HOME, dialect };
}

/** Each call the line makes through a link, as `<call> @ <link>`. */
async function writesOf(line: string, cwd: string | undefined = APP, tree = linkedTree()): Promise<string[]> {
  return (await linkedModulesWritesOf(line, context(cwd), tree)).map(({ call, modules }) => `${call} @ ${modules}`);
}

describe('linkedModulesWritesOf', () => {
  it('names the call, the link and where it points', async () => {
    assert.deepEqual(await linkedModulesWritesOf('npm ci', context(APP), linkedTree()), [{ call: 'npm ci', modules: join(APP, 'node_modules'), target: MAIN }]);
  });

  it('counts every call that rewrites node_modules, for each package manager', async () => {
    const cases: readonly (readonly [string, string])[] = [
      ['npm ci', 'npm ci'],
      ['npm clean-install', 'npm clean-install'],
      ['npm install', 'npm install'],
      ['npm i lodash@4.17.21', 'npm i'],
      ['npm update', 'npm update'],
      ['npm uninstall left-pad', 'npm uninstall'],
      ['npm prune --omit=dev', 'npm prune'],
      ['npm dedupe', 'npm dedupe'],
      ['npm --loglevel warn ci', 'npm ci'],
      ['yarn', 'yarn'],
      ['yarn --frozen-lockfile', 'yarn'],
      ['yarn install', 'yarn install'],
      ['yarn add vite@5.4.10', 'yarn add'],
      ['pnpm i', 'pnpm i'],
      ['pnpm install --frozen-lockfile', 'pnpm install'],
      ['pnpm remove zod', 'pnpm remove'],
      ['bun install', 'bun install'],
      ['bun add zod@3.23.8', 'bun add'],
    ];
    for (const [line, call] of cases) {
      assert.deepEqual(await writesOf(line), [`${call} @ ${join(APP, 'node_modules')}`], line);
    }
  });

  it('counts each call of a line, under a teamrig runner or a nested shell too', async () => {
    const link = join(APP, 'node_modules');
    assert.deepEqual(await writesOf('npm ci && yarn'), [`npm ci @ ${link}`, `yarn @ ${link}`]);
    assert.deepEqual(await writesOf('teamrig queue --session s --what w -- npm ci'), [`npm ci @ ${link}`]);
    assert.deepEqual(await writesOf('teamrig heavy --session s --what w -- npm ci'), [`npm ci @ ${link}`]);
    assert.deepEqual(await writesOf('sh -c "cd app && npm ci"', WORK), [`npm ci @ ${link}`]);
    assert.deepEqual(await linkedModulesWritesOf('npm ci', context(APP, 'powershell'), linkedTree()), [{ call: 'npm ci', modules: link, target: MAIN }]);
  });

  it('walks up from a subfolder to the link above it, as an install there writes the project root', async () => {
    assert.deepEqual(await writesOf('cd sub && npm ci'), [`npm ci @ ${join(APP, 'node_modules')}`]);
    assert.deepEqual(await writesOf('npm ci', join(APP, 'sub')), [`npm ci @ ${join(APP, 'node_modules')}`]);
  });

  it('reads the folder a call names instead of the one it starts in', async () => {
    const link = join(APP, 'node_modules');
    const cases: readonly (readonly [string, string])[] = [
      ['npm --prefix app ci', 'npm ci'],
      ['npm ci --prefix app', 'npm ci'],
      ['npm ci --prefix=app', 'npm ci'],
      ['pnpm -C app install', 'pnpm install'],
      ['pnpm --dir app i', 'pnpm i'],
      ['yarn --cwd app', 'yarn'],
      ['yarn --cwd app add zod@3.23.8', 'yarn add'],
      ['bun --cwd app install', 'bun install'],
      ['bun install --cwd app', 'bun install'],
    ];
    for (const [line, call] of cases) {
      assert.deepEqual(await writesOf(line, WORK), [`${call} @ ${link}`], line);
    }
    assert.deepEqual(await writesOf('npm ci --prefix ../elsewhere'), [], 'a folder outside the linked tree');
  });

  it('passes a global install, a call that leaves node_modules alone, and a non-manager', async () => {
    const lines = [
      'npm i -g typescript@5.6.3',
      'npm install --global typescript@5.6.3',
      'npm i --location=global typescript@5.6.3',
      'npm i --location global typescript@5.6.3',
      'npm -g update',
      'yarn global add serve@14.2.4',
      'pnpm add -g serve@14.2.4',
      'bun add --global serve@14.2.4',
      'npm run build',
      'npm test',
      'npm ls',
      'npm exec tsc',
      'yarn run build',
      'yarn build',
      'pnpm exec tsc',
      'bun run build',
      'npx tsc -p .',
      'node --test',
      'echo npm ci',
    ];
    for (const line of lines) {
      assert.deepEqual(await writesOf(line), [], line);
    }
  });

  it('skips a call whose subcommand or folder is only known when the line runs', async () => {
    for (const line of ['npm "$CMD"', 'npm --prefix "$DIR" ci', 'npm ci --prefix "$DIR"', 'cd "$DIR" && npm ci']) {
      assert.deepEqual(await writesOf(line), [], line);
    }
    assert.deepEqual(await linkedModulesWritesOf('npm ci', context(undefined), linkedTree()), [], 'a line whose folder is not known');
  });

  it('passes a node_modules that is a real folder, or none at all', async () => {
    assert.deepEqual(await writesOf('npm ci', APP, new FakeWorktreeFiles({ [join(APP, 'node_modules')]: { kind: 'folder' } })), []);
    assert.deepEqual(await writesOf('npm ci', APP, new FakeWorktreeFiles()), []);
  });
});

describe('linkedModulesWritesOf on the real filesystem', () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'teamrig-linked-modules-')));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('finds a worktree junction to the main checkout node_modules, and passes the main checkout itself', async () => {
    const main = join(dir, 'main');
    const worktree = join(dir, 'worktree');
    mkdirSync(join(main, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(worktree);
    // A junction on Windows, which needs no privilege, as `teamrig worktree add` makes it; a symlink elsewhere.
    symlinkSync(join(main, 'node_modules'), join(worktree, 'node_modules'), 'junction');
    const writes = await linkedModulesWritesOf('npm ci', context(worktree), NODE_WORKTREE_FILES);
    assert.deepEqual(
      writes.map(({ call, modules, target }) => ({ call, modules, target: realpathSync.native(target) })),
      [{ call: 'npm ci', modules: join(worktree, 'node_modules'), target: join(main, 'node_modules') }],
    );
    assert.deepEqual(await linkedModulesWritesOf('npm ci', context(main), NODE_WORKTREE_FILES), []);
  });
});
