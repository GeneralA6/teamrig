import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import { GateHolds, gateHoldId, parseGateHold, type GateHold } from './gate-holds.ts';
import { holdId, type HeldChange } from './review-holds.ts';

const DIR = '/team/deploys/gate-holds';
const CHANGE: HeldChange = { repo: 'app', branch: 't9-gate', base: 'base', head: 'head', tree: 'tree' };
const HOLD: GateHold = {
  ...CHANGE,
  id: gateHoldId(CHANGE),
  task: 'T9',
  session: 'alpha',
  reviewer: 'lead',
  misses: [{ gate: 'pass', why: 'no pass record' }],
  createdAt: '2030-01-08T10:00:00.000Z',
};

describe('gateHoldId', () => {
  it("names the change by the review hold's hash, after a G", () => {
    assert.match(gateHoldId(CHANGE), /^G[0-9a-f]{12}$/);
    assert.equal(gateHoldId(CHANGE).slice(1), holdId(CHANGE).slice(1));
    assert.notEqual(gateHoldId(CHANGE), gateHoldId({ ...CHANGE, tree: 'other' }));
  });
});

describe('GateHolds', () => {
  it('writes one hold a branch, reads it back and removes it', async () => {
    const files = new MemoryFiles();
    const holds = new GateHolds(files, DIR);
    await holds.write(HOLD);
    await holds.write({ ...HOLD, branch: 'feat/t9 x' });
    assert.deepEqual(files.paths(), [`${DIR}/app~feat%2Ft9%20x.json`, `${DIR}/app~t9-gate.json`]);
    assert.deepEqual(await holds.read('app', 't9-gate'), HOLD);
    assert.equal(await holds.remove('app', 't9-gate'), true);
    assert.equal(await holds.read('app', 't9-gate'), undefined);
    assert.equal(await holds.remove('app', 't9-gate'), false);
  });

  it('reads a damaged hold as none', () => {
    const damaged = [undefined, 'not json', '[]', { ...HOLD, task: 9 }, { ...HOLD, misses: [] }, { ...HOLD, misses: [{ gate: 'luck', why: 'x' }] }, { ...HOLD, misses: [{ gate: 'pass' }] }];
    for (const value of damaged) {
      const text = value === undefined || typeof value === 'string' ? value : JSON.stringify(value);
      assert.equal(parseGateHold(text), undefined, text);
    }
  });
});
