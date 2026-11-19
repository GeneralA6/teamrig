import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDeclarations } from '../../src/composition/loader.ts';
import { TOOLS_REPO } from '../lib/repo-root.ts';
import { type CliRun, TempRepo } from '../lib/temp-repo.ts';
import { PARITY_DOC, renderParity } from './parity.ts';

const CLI = fileURLToPath(new URL('./parity-cli.ts', import.meta.url));
const PAGE = renderParity(await readDeclarations());
const STALE = 'parity: stale; run `npm run docs:parity` and commit the result\n';

describe('parity-cli', () => {
  let repo: TempRepo;
  /** Runs the CLI on the temp repo from a folder outside it, so a write by the cwd would land in the wrong place. */
  const draw = (args: readonly string[] = []): CliRun => repo.runOutside(CLI, [...args, '--root', repo.dir]);
  beforeEach(() => {
    repo = new TempRepo('parity');
  });
  afterEach(() => repo.remove());

  it('draws the page into docs/parity.md of the --root repo, not the cwd', () => {
    const result = draw();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `parity: wrote ${PARITY_DOC}\n`);
    assert.equal(readFileSync(join(repo.dir, PARITY_DOC), 'utf8'), PAGE);
    assert.deepEqual(readdirSync(repo.outside), []);
  });

  it('--check passes on a fresh page and changes nothing', () => {
    draw();
    const result = draw(['--check']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `parity: ${PARITY_DOC} is up to date\n`);
    assert.equal(readFileSync(join(repo.dir, PARITY_DOC), 'utf8'), PAGE);
  });

  it('--check reports a missing or changed page and exits 1 without drawing it', () => {
    const missing = draw(['--check']);
    assert.equal(missing.status, 1, missing.stderr);
    assert.equal(missing.stdout, STALE);
    assert.equal(existsSync(join(repo.dir, PARITY_DOC)), false);
    repo.write(PARITY_DOC, '# Feature parity\n');
    const changed = draw(['--check']);
    assert.equal(changed.status, 1, changed.stderr);
    assert.equal(changed.stdout, STALE);
    assert.equal(readFileSync(join(repo.dir, PARITY_DOC), 'utf8'), '# Feature parity\n');
  });

  it("finds this repo's committed page up to date, from any cwd, and writes nothing there", () => {
    const foreign = repo.runOutside(CLI, ['--check']);
    assert.equal(foreign.stderr, '');
    assert.equal(foreign.stdout, `parity: ${PARITY_DOC} is up to date\n`);
    assert.deepEqual(foreign, repo.runOutside(CLI, ['--check', '--root', TOOLS_REPO]));
    assert.deepEqual(readdirSync(repo.outside), []);
  });

  it('exits 2 on an unknown option or a --root with no folder', () => {
    const unknown = draw(['--fix']);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stderr, 'parity: unknown option --fix (usage: parity-cli.ts [--check] [--root <repo>])\n');
    const bare = repo.runOutside(CLI, ['--root']);
    assert.equal(bare.status, 2);
    assert.equal(bare.stderr, 'parity: --root needs a folder\n');
  });
});
