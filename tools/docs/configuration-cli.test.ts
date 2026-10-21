import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TempRepo } from '../lib/temp-repo.ts';
import { CONFIG_DOC, loadConfigSchema, renderConfigReference } from './configuration.ts';

const CLI = fileURLToPath(new URL('./configuration-cli.ts', import.meta.url));
const PAGE = renderConfigReference(loadConfigSchema());
const STALE = 'config: stale; run `npm run docs:config` and commit the result\n';

describe('configuration-cli', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo('config');
  });
  afterEach(() => repo.remove());

  it('draws the page into docs/configuration.md', () => {
    const result = repo.run(CLI);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `config: wrote ${CONFIG_DOC}\n`);
    assert.equal(readFileSync(join(repo.dir, CONFIG_DOC), 'utf8'), PAGE);
  });

  it('--check passes on a fresh page and changes nothing', () => {
    repo.run(CLI);
    const result = repo.run(CLI, ['--check']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `config: ${CONFIG_DOC} is up to date\n`);
    assert.equal(readFileSync(join(repo.dir, CONFIG_DOC), 'utf8'), PAGE);
  });

  it('--check reports a missing or changed page and exits 1 without drawing it', () => {
    const missing = repo.run(CLI, ['--check']);
    assert.equal(missing.status, 1, missing.stderr);
    assert.equal(missing.stdout, STALE);
    assert.equal(existsSync(join(repo.dir, CONFIG_DOC)), false);
    repo.write(CONFIG_DOC, '# Configuration reference\n');
    const changed = repo.run(CLI, ['--check']);
    assert.equal(changed.status, 1, changed.stderr);
    assert.equal(changed.stdout, STALE);
    assert.equal(readFileSync(join(repo.dir, CONFIG_DOC), 'utf8'), '# Configuration reference\n');
  });

  it('exits 2 on an unknown option', () => {
    const result = repo.run(CLI, ['--fix']);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, 'config: unknown option --fix (usage: configuration-cli.ts [--check])\n');
  });
});
