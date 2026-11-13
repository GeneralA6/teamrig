import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SECRET_BODY } from '../github/map.ts';
import { testTask } from '../testing/task.ts';
import { mirroredIssues, similarIssues, tokens, type SimilarDoc } from './similar.ts';

const NOW = new Date('2030-01-20T12:00:00.000Z');

function doc(number: number, title: string, body = ''): SimilarDoc {
  return { ref: `gh:acme/kit#${number}`, title, body };
}

describe('tokens', () => {
  it('keeps a path or a version whole and by its parts', () => {
    assert.deepEqual(tokens('src/core/version.ts'), ['src/core/version.ts', 'src', 'core', 'version', 'ts']);
    assert.deepEqual(tokens('0.351.0'), ['0.351.0', '0', '351', '0']);
  });

  it('splits a hyphened word into its parts without keeping it whole', () => {
    assert.deepEqual(tokens('exec-policy'), ['exec', 'policy']);
  });

  it('drops stop words and lone letters, keeps digits, lowercases', () => {
    assert.deepEqual(tokens('The Hook is a b 7 Crash'), ['hook', '7', 'crash']);
  });

  it('reads no words from an empty text', () => {
    assert.deepEqual(tokens(''), []);
  });
});

describe('similarIssues', () => {
  const corpus = [
    doc(1, 'Pane crashes when the register file is empty', 'Opening the pane with an empty events.jsonl throws in fold.'),
    doc(2, 'Add dark mode to the status line', 'The status line should follow the terminal theme.'),
    doc(3, 'Inbox add refuses multi-line text', 'teamrig inbox add cuts the text at the first newline on Windows.'),
    doc(4, 'Budget week reset day is wrong', 'The week resets on Wednesday, the status shows Thursday.'),
  ];

  it('scores a duplicate high and leaves unrelated issues below the threshold', () => {
    const target = doc(9, 'Pane crash on an empty register file', 'The pane throws in fold when events.jsonl is empty.');
    const matches = similarIssues(target, corpus, 0.35);
    assert.deepEqual(
      matches.map((match) => match.ref),
      ['gh:acme/kit#1'],
    );
    const [first] = matches;
    assert.ok(first !== undefined && first.score > 0.5, `duplicate scored ${String(first?.score)}`);
    assert.equal(first.title, 'Pane crashes when the register file is empty');
  });

  it('leaves the target itself out of the corpus', () => {
    const [first] = corpus;
    assert.ok(first !== undefined);
    assert.deepEqual(
      similarIssues(first, corpus, 0.35).map((match) => match.ref),
      [],
    );
  });

  it('keeps at most `top` matches, best first', () => {
    const many = [doc(1, 'hook crash'), doc(2, 'hook crash'), doc(3, 'hook crash'), doc(4, 'hook crash'), doc(5, 'unrelated words')];
    const matches = similarIssues(doc(9, 'hook crash'), many, 0.1);
    assert.equal(matches.length, 3);
    assert.deepEqual(
      similarIssues(doc(9, 'hook crash'), many, 0.1, 2).map((match) => match.ref),
      ['gh:acme/kit#1', 'gh:acme/kit#2'],
    );
    const scores = matches.map((match) => match.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  });

  it('breaks an equal score by ref, whatever the corpus order', () => {
    const tied = [doc(3, 'hook crash'), doc(1, 'hook crash'), doc(2, 'hook crash')];
    assert.deepEqual(
      similarIssues(doc(9, 'hook crash'), tied, 0.1).map((match) => match.ref),
      ['gh:acme/kit#1', 'gh:acme/kit#2', 'gh:acme/kit#3'],
    );
  });

  it('weighs a title word over a body word', () => {
    const inTitle = doc(1, 'scheduler', 'nothing else here');
    const inBody = doc(2, 'nothing else here', 'scheduler');
    const [best] = similarIssues(doc(9, 'scheduler', ''), [inBody, inTitle, doc(3, 'filler words')], 0);
    assert.equal(best?.ref, 'gh:acme/kit#1');
  });

  it('reads only the first BODY_CHARS of a body', () => {
    const late = doc(1, 'filler', `${'padding '.repeat(200)}scheduler`);
    assert.deepEqual(similarIssues(doc(9, 'scheduler'), [late, doc(2, 'other')], 0.01), []);
  });

  it('finds nothing for a target with no counted words, or a corpus of empty issues', () => {
    assert.deepEqual(similarIssues(doc(9, 'the a of', ''), corpus, 0), []);
    assert.deepEqual(similarIssues(doc(9, 'hook crash'), [doc(1, '', '')], 0), []);
  });
});

describe('mirroredIssues', () => {
  it('keeps active issue tasks and closed ones inside the window, nothing else', () => {
    const tasks = [
      testTask({ id: 'T1', ref: 'gh:acme/kit#1', title: 'open one', description: 'body one' }),
      testTask({ id: 'T2', ref: 'gh:acme/kit#2', title: 'done lately', status: 'done', statusAt: '2030-01-15T12:00:00.000Z' }),
      testTask({ id: 'T3', ref: 'gh:acme/kit#3', title: 'done long ago', status: 'done', statusAt: '2030-01-01T12:00:00.000Z' }),
      testTask({ id: 'T4', ref: 'T100', title: 'not an issue' }),
      testTask({ id: 'T5', ref: null, title: 'no ref' }),
      testTask({ id: 'T6', ref: 'gh:acme/kit#6', title: 'dropped lately', status: 'dropped', statusAt: '2030-01-19T12:00:00.000Z' }),
    ];
    assert.deepEqual(mirroredIssues(tasks, NOW, 14), [
      { ref: 'gh:acme/kit#1', title: 'open one', body: 'body one' },
      { ref: 'gh:acme/kit#2', title: 'done lately', body: '' },
      { ref: 'gh:acme/kit#6', title: 'dropped lately', body: '' },
    ]);
  });

  it('keeps a closed issue on the window edge', () => {
    const edge = testTask({ ref: 'gh:acme/kit#1', status: 'done', statusAt: '2030-01-06T12:00:00.000Z' });
    assert.equal(mirroredIssues([edge], NOW, 14).length, 1);
  });

  it('reads a body left out as a likely secret as none', () => {
    const secret = testTask({ ref: 'gh:acme/kit#1', title: 'leaked', description: SECRET_BODY });
    assert.deepEqual(mirroredIssues([secret], NOW, 14), [{ ref: 'gh:acme/kit#1', title: 'leaked', body: '' }]);
  });
});
