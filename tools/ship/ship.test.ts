import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TempRepo } from '../lib/temp-repo.ts';
import { SHIP_USAGE } from './ship-plan.ts';

const CLI = fileURLToPath(new URL('./ship.ts', import.meta.url));

/** Runs as its own process: ship.ts dispatches on import. Only refusals run here, which stop before any git or GitHub call. */
describe('ship cli', () => {
  let repo: TempRepo;

  beforeEach(() => {
    repo = new TempRepo('ship-cli');
  });
  afterEach(() => repo.remove());

  it('prints its usage and exits 1 with no arguments', () => {
    const result = repo.run(CLI);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stderr, `${SHIP_USAGE}\n`);
  });

  it('hands check, merge and leftovers to their own commands', () => {
    const check = repo.run(CLI, ['check']);
    assert.equal(check.status, 1, check.stdout);
    assert.equal(check.stderr, 'usage: ship.ts check <repo dir>\n');
    const merge = repo.run(CLI, ['merge']);
    assert.equal(merge.status, 1, merge.stdout);
    assert.match(merge.stderr, /^usage: ship\.ts merge <repo dir> \[--head <branch>\]/);
    const leftovers = repo.run(CLI, ['leftovers']);
    assert.equal(leftovers.status, 1, leftovers.stdout);
    assert.equal(leftovers.stderr, 'usage: ship.ts leftovers <repo dir>\n');
  });

  it('refuses a plan with no chunks before it touches the repo', () => {
    const plan = repo.write('plan.json', '{ "chunks": [] }');
    const result = repo.run(CLI, [repo.dir, plan]);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stderr, `${plan}: expected { "chunks": [ ... ] }\n`);
  });
});
