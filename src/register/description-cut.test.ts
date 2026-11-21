import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testTask } from '../testing/task.ts';
import { cutOf, cutTask, describedTask, holdsDescription, parseDescriptionCut, textHash } from './description-cut.ts';

/** FNV-1a (32 bits) over the text's UTF-16LE bytes, worked in whole numbers: a second way to the same digits. */
function referenceHash(text: string): string {
  let hash = 0x811c9dc5n;
  for (const byte of Buffer.from(text, 'utf16le')) {
    hash = ((hash ^ BigInt(byte)) * 0x01000193n) & 0xffffffffn;
  }
  return hash.toString(16).padStart(8, '0');
}

const TEXTS = ['', 'a', 'Add a health check', 'שלום 😀', 'line one\nline two\n', 'x'.repeat(5000)];

describe('textHash', () => {
  it('gives the FNV-1a digits of known texts', () => {
    assert.equal(textHash(''), '811c9dc5');
    assert.equal(textHash('a'), '2b24d044');
    assert.equal(textHash('Add a health check'), '42339ebf');
    assert.equal(textHash('שלום 😀'), '5381e457');
  });

  it('agrees with FNV-1a over the UTF-16LE bytes on every text', () => {
    for (const text of TEXTS) {
      assert.equal(textHash(text), referenceHash(text), JSON.stringify(text.slice(0, 20)));
    }
  });

  it('tells texts of one length apart', () => {
    assert.notEqual(textHash('Add a health check'), textHash('Add a health chick'));
    assert.notEqual(textHash('ab'), textHash('ba'));
  });
});

describe('cutOf', () => {
  it('holds the length and the hash of the whole text', () => {
    assert.deepEqual(cutOf('Add a health check'), { chars: 18, hash: '42339ebf' });
    assert.deepEqual(cutOf('שלום 😀'), { chars: 7, hash: '5381e457' });
  });
});

describe('cutTask', () => {
  it('leaves the description out and keeps its mark', () => {
    const task = testTask({ description: 'Add a health check' });
    assert.deepEqual(cutTask(task), { ...task, description: null, descriptionCut: { chars: 18, hash: '42339ebf' } });
  });

  it('returns a task with no description as it is', () => {
    const task = testTask();
    assert.equal(cutTask(task), task);
  });

  it('gives the same task when cut twice', () => {
    const once = cutTask(testTask({ description: 'Add a health check' }));
    assert.equal(cutTask(once), once);
  });

  it('keeps every other field', () => {
    const task = testTask({ description: 'why', note: 'a note', ref: 'gh:acme/web#7', title: 'A title' });
    const { description, descriptionCut, ...rest } = cutTask(task);
    const { description: whole, descriptionCut: none, ...before } = task;
    assert.deepEqual(rest, before);
    assert.deepEqual([description, descriptionCut, whole, none], [null, cutOf('why'), 'why', null]);
  });
});

describe('holdsDescription', () => {
  it('compares a whole description as text', () => {
    const task = testTask({ description: 'Add a health check' });
    assert.equal(holdsDescription(task, 'Add a health check'), true);
    assert.equal(holdsDescription(task, 'Add a health chick'), false);
    assert.equal(holdsDescription(task, null), false);
  });

  it('takes no description as none', () => {
    assert.equal(holdsDescription(testTask(), null), true);
    assert.equal(holdsDescription(testTask(), 'a text'), false);
  });

  it('compares a cut description by its mark', () => {
    const task = cutTask(testTask({ description: 'Add a health check' }));
    assert.equal(holdsDescription(task, 'Add a health check'), true);
    assert.equal(holdsDescription(task, 'Add a health chick'), false, 'an edit of the same length');
    assert.equal(holdsDescription(task, 'Add a health check.'), false);
    assert.equal(holdsDescription(task, null), false, 'a cut task has a description');
  });
});

describe('describedTask', () => {
  const whole = testTask({ description: 'Add a health check', note: 'as the history folds it' });

  it('gives a cut task the text the history holds, and no mark', () => {
    const cut = cutTask(testTask({ description: 'Add a health check', note: 'as the working set folds it' }));
    assert.deepEqual(describedTask(cut, whole), testTask({ description: 'Add a health check', note: 'as the working set folds it' }));
  });

  it('returns a task that is not cut as is', () => {
    const none = testTask();
    const held = testTask({ description: 'Add a readiness check' });
    assert.equal(describedTask(none, whole), none);
    assert.equal(describedTask(held, whole), held);
  });

  it('leaves a cut task cut when the history lacks it, or holds another text than the one cut', () => {
    const cut = cutTask(testTask({ description: 'Add a health check' }));
    assert.equal(describedTask(cut, undefined), cut);
    assert.equal(describedTask(cut, testTask({ description: 'Add a health chick' })), cut);
    assert.equal(describedTask(cut, testTask()), cut);
  });
});

describe('parseDescriptionCut', () => {
  it('reads null and a mark', () => {
    assert.equal(parseDescriptionCut(null), null);
    assert.deepEqual(parseDescriptionCut({ chars: 18, hash: '42339ebf' }), { chars: 18, hash: '42339ebf' });
    assert.deepEqual(parseDescriptionCut({ chars: 0, hash: '811c9dc5', more: true }), { chars: 0, hash: '811c9dc5' });
  });

  it('refuses a missing value and any other shape', () => {
    assert.equal(parseDescriptionCut(undefined), 'descriptionCut is neither a mark nor null');
    assert.equal(parseDescriptionCut('42339ebf'), 'descriptionCut is neither a mark nor null');
    assert.equal(parseDescriptionCut({ chars: -1, hash: '42339ebf' }), 'bad descriptionCut {"chars":-1,"hash":"42339ebf"}');
    assert.equal(parseDescriptionCut({ chars: 1.5, hash: '42339ebf' }), 'bad descriptionCut {"chars":1.5,"hash":"42339ebf"}');
    assert.equal(parseDescriptionCut({ chars: 18, hash: '42339EBF' }), 'bad descriptionCut {"chars":18,"hash":"42339EBF"}');
    assert.equal(parseDescriptionCut({ chars: 18, hash: '42339eb' }), 'bad descriptionCut {"chars":18,"hash":"42339eb"}');
    assert.equal(parseDescriptionCut({ chars: 18 }), 'bad descriptionCut {"chars":18}');
  });
});
