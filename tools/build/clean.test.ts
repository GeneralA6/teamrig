import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DIST_DIR } from '../ci/dist-fresh.ts';
import { TempRepo } from '../lib/temp-repo.ts';

const CLI = fileURLToPath(new URL('./clean.ts', import.meta.url));

describe('clean', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo('clean');
  });
  afterEach(() => repo.remove());

  it('removes the dist folder and nothing beside it', () => {
    repo.write(`${DIST_DIR}/cli/main.js`, 'export {};\n');
    repo.write('plugins/teamrig/bin/teamrig', '#!/bin/sh\n');
    const result = repo.run(CLI);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(repo.has(DIST_DIR), false);
    assert.equal(repo.has('plugins/teamrig/bin/teamrig'), true);
  });

  it('passes when there is no dist folder', () => {
    const result = repo.run(CLI);
    assert.equal(result.status, 0, result.stderr);
  });
});
