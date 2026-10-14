import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { TempRepo } from '../lib/temp-repo.ts';
import { DIST_DIR } from './dist-fresh.ts';

const CLI = fileURLToPath(new URL('./dist-fresh-cli.ts', import.meta.url));
const MAIN = `${DIST_DIR}/cli/main.js`;

describe('dist-fresh-cli', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo('dist-fresh');
  });
  afterEach(() => repo.remove());

  it('passes when the dist matches the committed one', () => {
    repo.init().write(MAIN, 'export {};\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'build');
    const result = repo.run(CLI);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `dist-fresh: ${DIST_DIR} matches the source\n`);
  });

  it('lists every changed and new dist file and exits 1', () => {
    repo.init().write(MAIN, 'export {};\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'build');
    repo.write(MAIN, 'export const changed = 1;\n');
    repo.write(`${DIST_DIR}/cli/extra.js`, 'export {};\n');
    const result = repo.run(CLI);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /is stale; run `npm run build` and commit the result:/);
    assert.match(result.stdout, new RegExp(`^ {2} M ${MAIN}$`, 'm'));
    assert.match(result.stdout, new RegExp(`^ {2}\\?\\? ${DIST_DIR}/cli/extra\\.js$`, 'm'));
  });

  it('exits 2 with the git error outside a repo', () => {
    const result = repo.run(CLI);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /^dist-fresh: git status .* failed: /);
  });
});
