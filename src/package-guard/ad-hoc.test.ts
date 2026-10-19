import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { adHocCallsOf } from './ad-hoc.ts';

const APP = resolve('/', 'work', 'app');
const CONTEXT = { cwd: APP, home: resolve('/', 'u'), dialect: 'bash' } as const;

/** Files with each bin installed in the folder's node_modules/.bin. */
function installed(dir: string, ...bins: readonly string[]): MemoryFiles {
  return new MemoryFiles(Object.fromEntries(bins.map((bin) => [join(dir, 'node_modules', '.bin', `${bin}.cmd`), ''])));
}

describe('adHocCallsOf', () => {
  it('lists an npx of a bin not installed where it runs, and lets an installed one run', async () => {
    assert.deepEqual(await adHocCallsOf('npx eslint .', CONTEXT, new MemoryFiles()), ['npx eslint']);
    assert.deepEqual(await adHocCallsOf('npx eslint .', CONTEXT, installed(APP, 'eslint')), []);
    assert.deepEqual(await adHocCallsOf('cd sub && npx eslint .', CONTEXT, installed(APP, 'eslint')), []);
  });

  it('looks for the bin under the prefix npx is given, and lists it when that folder is only known when it runs', async () => {
    const sub = join(APP, 'sub');
    assert.deepEqual(await adHocCallsOf('npx --prefix sub eslint', CONTEXT, installed(sub, 'eslint')), []);
    assert.deepEqual(await adHocCallsOf('npx --prefix other eslint', CONTEXT, installed(sub, 'eslint')), ['npx eslint']);
    assert.deepEqual(await adHocCallsOf('npx --prefix "$D" eslint', CONTEXT, installed(APP, 'eslint')), ['npx eslint']);
    assert.deepEqual(await adHocCallsOf('cd "$D" && npx eslint', CONTEXT, installed(APP, 'eslint')), ['npx eslint']);
  });

  it('lists every call that fetches, each once, and nothing for a line without one', async () => {
    const line = 'npm ci && npx eslint . && pnpm dlx cowsay && pnpm dlx cowsay; npm create vite x';
    assert.deepEqual(await adHocCallsOf(line, CONTEXT, installed(APP, 'eslint')), ['pnpm dlx cowsay', 'npm create vite']);
    assert.deepEqual(await adHocCallsOf('git status && npm test', CONTEXT, new MemoryFiles()), []);
  });

  it('lists no npx call that hands its flag to npm, as npm runs and fetches nothing', async () => {
    assert.deepEqual(await adHocCallsOf('npx --no tsc --version', CONTEXT, new MemoryFiles()), []);
  });
});
