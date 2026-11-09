import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS_REPO } from '../lib/repo-root.ts';
import { type CliRun, TempRepo } from '../lib/temp-repo.ts';
import { CONFIG_DOC, loadConfigSchema, renderConfigReference } from './configuration.ts';

const CLI = fileURLToPath(new URL('./configuration-cli.ts', import.meta.url));
const PAGE = renderConfigReference(loadConfigSchema());
const STALE = 'config: stale; run `npm run docs:config` and commit the result\n';

describe('configuration-cli', () => {
  let repo: TempRepo;
  /** Runs the CLI on the temp repo from a folder outside it, so a write by the cwd would land in the wrong place. */
  const draw = (args: readonly string[] = []): CliRun => repo.runOutside(CLI, [...args, '--root', repo.dir]);
  beforeEach(() => {
    repo = new TempRepo('config');
  });
  afterEach(() => repo.remove());

  it('draws the page into docs/configuration.md of the --root repo, not the cwd', () => {
    const result = draw();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `config: wrote ${CONFIG_DOC}\n`);
    assert.equal(readFileSync(join(repo.dir, CONFIG_DOC), 'utf8'), PAGE);
    assert.deepEqual(readdirSync(repo.outside), []);
  });

  it('--check passes on a fresh page and changes nothing', () => {
    draw();
    const result = draw(['--check']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `config: ${CONFIG_DOC} is up to date\n`);
    assert.equal(readFileSync(join(repo.dir, CONFIG_DOC), 'utf8'), PAGE);
  });

  it('--check reports a missing or changed page and exits 1 without drawing it', () => {
    const missing = draw(['--check']);
    assert.equal(missing.status, 1, missing.stderr);
    assert.equal(missing.stdout, STALE);
    assert.equal(existsSync(join(repo.dir, CONFIG_DOC)), false);
    repo.write(CONFIG_DOC, '# Configuration reference\n');
    const changed = draw(['--check']);
    assert.equal(changed.status, 1, changed.stderr);
    assert.equal(changed.stdout, STALE);
    assert.equal(readFileSync(join(repo.dir, CONFIG_DOC), 'utf8'), '# Configuration reference\n');
  });

  it('checks its own repo, not the cwd, when no --root is given, and writes nothing in the cwd', () => {
    const foreign = repo.runOutside(CLI, ['--check']);
    assert.equal(foreign.stderr, '');
    assert.deepEqual(foreign, repo.runOutside(CLI, ['--check', '--root', TOOLS_REPO]));
    assert.deepEqual(readdirSync(repo.outside), []);
  });

  it('exits 2 on an unknown option or a --root with no folder', () => {
    const unknown = draw(['--fix']);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stderr, 'config: unknown option --fix (usage: configuration-cli.ts [--check] [--root <repo>])\n');
    const bare = repo.runOutside(CLI, ['--root']);
    assert.equal(bare.status, 2);
    assert.equal(bare.stderr, 'config: --root needs a folder\n');
  });
});
