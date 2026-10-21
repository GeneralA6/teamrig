import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import { holdBinds, holdId, ReviewHolds, type HeldChange, type ReviewHold } from './review-holds.ts';

const DIR = '/team/deploys/review-holds';
const CHANGE: HeldChange = { repo: 'teamrig', branch: 'feature/t9-gate', base: 'b1', head: 'h1', tree: 't1' };
const HOLD: ReviewHold = {
  ...CHANGE,
  id: holdId(CHANGE),
  task: 'T9',
  session: 'alpha',
  holdClass: 'security',
  reviewer: { who: 'security', fallback: 'lead' },
  hits: [{ path: 'package-lock.json', glob: 'package-lock.json' }],
  findings: undefined,
  createdAt: '2030-01-08T10:00:00.000Z',
};

describe('holdId and holdBinds', () => {
  it('gives the same change the same id, and another change another', () => {
    assert.match(holdId(CHANGE), /^H[0-9a-f]{12}$/);
    assert.equal(holdId({ ...CHANGE }), holdId(CHANGE));
    assert.notEqual(holdId({ ...CHANGE, head: 'h2' }), holdId(CHANGE));
    assert.notEqual(holdId({ ...CHANGE, tree: 't2' }), holdId(CHANGE));
  });

  it('binds only the very commits and tree of the branch it held', () => {
    assert.equal(holdBinds(HOLD, CHANGE), true);
    for (const moved of [{ base: 'b2' }, { head: 'h2' }, { tree: 't2' }, { branch: 'other' }, { repo: 'web' }]) {
      assert.equal(holdBinds(HOLD, { ...CHANGE, ...moved }), false, JSON.stringify(moved));
    }
  });
});

describe('ReviewHolds', () => {
  it('writes a hold, reads it back, and removes it once the branch lands', async () => {
    const files = new MemoryFiles();
    const holds = new ReviewHolds(files, DIR);
    const flagged: ReviewHold = { ...HOLD, reviewer: { who: 'lead', fallback: undefined }, findings: '[{"rule":"token"}]' };
    await holds.write(flagged);
    assert.ok((await files.list(DIR)).includes('teamrig~feature%2Ft9-gate.json'), 'a branch with a slash is one file name');
    assert.deepEqual(await holds.read('teamrig', 'feature/t9-gate'), flagged);
    assert.equal(await holds.remove('teamrig', 'feature/t9-gate'), true);
    assert.equal(await holds.read('teamrig', 'feature/t9-gate'), undefined);
    assert.equal(await holds.remove('teamrig', 'feature/t9-gate'), false);
  });

  it("replaces a branch's hold with its newer one", async () => {
    const holds = new ReviewHolds(new MemoryFiles(), DIR);
    await holds.write(HOLD);
    const newer = { ...HOLD, head: 'h2', id: holdId({ ...CHANGE, head: 'h2' }) };
    await holds.write(newer);
    assert.deepEqual(await holds.read(CHANGE.repo, CHANGE.branch), newer);
  });

  it('reads a file that is not a hold as none', async () => {
    const path = `${DIR}/teamrig~feature%2Ft9-gate.json`;
    for (const text of ['not json', '[]', JSON.stringify({ ...HOLD, holdClass: 'owner' }), JSON.stringify({ ...HOLD, hits: [{ path: 'x' }] }), JSON.stringify({ ...HOLD, reviewer: {} })]) {
      const holds = new ReviewHolds(new MemoryFiles({ [path]: text }), DIR);
      assert.equal(await holds.read(CHANGE.repo, CHANGE.branch), undefined, text);
    }
  });
});
