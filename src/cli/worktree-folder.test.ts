import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { NO_PATHS_HOST, SHIPPED_HOST } from '../testing/host.ts';
import { worktreeFolderOf } from './worktree-folder.ts';

const MAIN = resolve('/w/main');
const SHIPPED = { host: SHIPPED_HOST, env: {}, platform: 'linux' } as const;
const NO_PATHS = { host: NO_PATHS_HOST, env: {}, platform: 'linux' } as const;

describe('worktreeFolderOf', () => {
  it('gives the folder the repository sets, a relative one counted from its main checkout, whatever the host', () => {
    for (const runtime of [SHIPPED, NO_PATHS]) {
      assert.equal(worktreeFolderOf(runtime, '/w/main', '../wt'), resolve('/w/wt'));
      assert.equal(worktreeFolderOf(runtime, '/w/main', resolve('/elsewhere/wt')), resolve('/elsewhere/wt'));
    }
  });

  it('with none set, gives where the host makes its own worktrees of that checkout', () => {
    assert.equal(worktreeFolderOf(SHIPPED, '/w/main', undefined), join(MAIN, '.claude', 'worktrees'));
  });

  it('with none set, gives none on a host whose folders teamrig does not know, and guesses no default', () => {
    assert.equal(worktreeFolderOf(NO_PATHS, '/w/main', undefined), undefined);
  });
});
