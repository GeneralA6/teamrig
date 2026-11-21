import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { changedFrame, EVENTS, helloFrame, movedDocuments, type DocumentRevision } from './events.ts';
import { INTERFACE_VERSION } from './version.ts';

const NOW: readonly DocumentRevision[] = [
  { document: 'tasks', revision: 'a1' },
  { document: 'inbox', revision: 'b1' },
  { document: 'config', revision: null },
];

describe('the event frames', () => {
  it('names the two events of version 1', () => {
    assert.deepEqual(EVENTS, ['hello', 'changed']);
  });

  it('says hello with every followed document, an unstampable one as null', () => {
    assert.deepEqual(helloFrame(NOW), { interface: INTERFACE_VERSION, event: 'hello', documents: NOW });
  });

  it('names as moved only the documents whose revision differs, in the order followed', () => {
    const before: readonly DocumentRevision[] = [
      { document: 'config', revision: null },
      { document: 'inbox', revision: 'b0' },
      { document: 'tasks', revision: 'a1' },
    ];
    assert.deepEqual(movedDocuments(before, NOW), [{ document: 'inbox', revision: 'b1' }]);
    assert.deepEqual(movedDocuments(NOW, NOW), []);
  });

  it('takes a document that became stampable, or stopped being, as moved', () => {
    const before: readonly DocumentRevision[] = [
      { document: 'tasks', revision: null },
      { document: 'inbox', revision: 'b1' },
      { document: 'config', revision: 'c0' },
    ];
    assert.deepEqual(movedDocuments(before, NOW), [
      { document: 'tasks', revision: 'a1' },
      { document: 'config', revision: null },
    ]);
  });

  it('takes a document not held before as moved', () => {
    assert.deepEqual(movedDocuments([], NOW), NOW);
  });

  it('sends no frame when nothing moved, and one naming what did', () => {
    assert.equal(changedFrame([]), undefined);
    const moved: readonly DocumentRevision[] = [{ document: 'tasks', revision: 'a2' }];
    assert.deepEqual(changedFrame(moved), { interface: INTERFACE_VERSION, event: 'changed', documents: moved });
  });

  it('writes a frame as one line', () => {
    assert.doesNotMatch(JSON.stringify(helloFrame(NOW)), /\n/);
  });
});
