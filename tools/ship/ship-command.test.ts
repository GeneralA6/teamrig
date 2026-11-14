import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { GateVerdict } from './local-gate.ts';
import { shipCommand, type ShipDepsFor } from './ship-command.ts';
import type { ShipDeps } from './ship-commits.ts';
import { SHIP_USAGE } from './ship-plan.ts';

const PASS: GateVerdict = { passed: true, tree: 'tree000', record: 'C:/records/tree000.json', reused: false };
const PLAN = { chunks: [{ files: ['src/a.ts'], subject: 'core: a', body: 'why a' }] };

interface Wiring {
  readonly repo: string;
  readonly noteFile: string | null;
}

/** Deps under which every step of a ship succeeds, but for the local gate's verdict and merge's exit code. */
function shipDeps(verdict: GateVerdict, mergeExit: number): ShipDeps {
  return {
    run: () => undefined,
    node: () => undefined,
    git: () => '',
    log: () => undefined,
    takeBack: () => undefined,
    sync: () => ({ kind: 'current', sets: '0.1.0' }),
    buildSteps: () => [],
    proveTree: () => verdict,
    push: () => 't827-ship-tool',
    merge: () => Promise.resolve({ kind: 'done', code: mergeExit }),
    mainMove: () => null,
  };
}

describe('shipCommand', () => {
  let dir: string;
  let wired: Wiring[];
  let errors: string[];
  const err = (line: string): void => {
    errors.push(line);
  };
  /** Records which repo dir and note file the deps were built for. */
  const depsFor =
    (verdict: GateVerdict = PASS, mergeExit = 0): ShipDepsFor =>
    (repo, noteFile) => {
      wired.push({ repo, noteFile });
      return shipDeps(verdict, mergeExit);
    };
  const writePlan = (plan: unknown): string => {
    const path = join(dir, 'plan.json');
    writeFileSync(path, JSON.stringify(plan));
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'teamrig-ship-command-'));
    wired = [];
    errors = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses bad arguments in one line before it builds any deps', async () => {
    assert.equal(await shipCommand([], depsFor(), err), 1);
    assert.deepEqual(errors, [SHIP_USAGE]);
    assert.deepEqual(wired, []);
  });

  it('refuses a plan with no chunks in one line before it builds any deps', async () => {
    const plan = writePlan({ chunks: [] });
    assert.equal(await shipCommand(['C:/repo', plan], depsFor(), err), 1);
    assert.deepEqual(errors, [`${plan}: expected { "chunks": [ ... ] }`]);
    assert.deepEqual(wired, []);
  });

  it('exits 0 once the local gate passes, with deps built for the repo dir it was given', async () => {
    assert.equal(await shipCommand(['C:/repo', writePlan(PLAN)], depsFor(), err), 0);
    assert.deepEqual(wired, [{ repo: 'C:/repo', noteFile: null }]);
    assert.deepEqual(errors, []);
  });

  it("with --merge, hands the note file to the deps and returns merge's exit code", async () => {
    const plan = writePlan(PLAN);
    assert.equal(await shipCommand(['C:/repo', plan, '--merge', '--note-file', 'note.md'], depsFor(PASS, 3), err), 3);
    assert.deepEqual(wired, [{ repo: 'C:/repo', noteFile: 'note.md' }]);
    assert.deepEqual(errors, []);
  });

  it('prints a refused local gate as one line, not a stack', async () => {
    const refused: GateVerdict = { passed: false, reason: 'tools/ci/local.ts failed on tree tree000' };
    assert.equal(await shipCommand(['C:/repo', writePlan(PLAN)], depsFor(refused), err), 1);
    assert.deepEqual(errors, ['REFUSED tools/ci/local.ts failed on tree tree000']);
  });
});
