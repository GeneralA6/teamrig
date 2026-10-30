import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMMIT_FORMAT, PATCH_FLAGS, commitsOf, gitPath, messageLines, patchAdds, tagOf } from './git-adds.ts';

const NUL = '\0';
const MERGE = '2a11ce333750631efa84d21a82649ca9d32d8b17';
const SECOND = '74d7d9a1aa2ee96b68d514b1a3ab793902af21e3';
const SIDE = '1a3f45714a243c07aeef1966157752fbfaec1b23';
const FIRST = '292903d346c154fc625af8012059a8c59c6913b0';
const CUT = '------------------------ >8 ------------------------';

/** The patch of the second commit below, as `git diff` prints it with `PATCH_FLAGS` and `core.quotePath=false`. */
const SECOND_PATCH = [
  'diff --git a.txt a.txt',
  'index 4cb29ea..657b95b 100644',
  '--- a.txt',
  '+++ a.txt',
  '@@ -2 +2 @@ one',
  '-two',
  '+TWO',
  '@@ -3,0 +4 @@ three',
  '+four',
  '\\ No newline at end of file',
  'diff --git k.p12 k.p12',
  'new file mode 100644',
  'index 0000000..88768ef',
  'Binary files /dev/null and k.p12 differ',
  'diff --git old name.txt new name.txt',
  'similarity index 59%',
  'rename from old name.txt',
  'rename to new name.txt',
  'index 44ab0cb..654c385 100644',
  '--- old name.txt\t',
  '+++ new name.txt\t',
  '@@ -3 +3 @@ line 2',
  '-line 3',
  '+line 3 changed',
  'diff --git p.txt p.txt',
  'new file mode 100644',
  'index 0000000..855f45e',
  '--- /dev/null',
  '+++ p.txt',
  '@@ -0,0 +1,2 @@',
  '+++ plus',
  '++++ x',
].join('\n');

/** Four commits, newest first, as `git log` prints them with `COMMIT_FORMAT -p` and `PATCH_FLAGS`; the first is a merge. */
const LOG = [
  `${NUL}${MERGE}${NUL}Merge branch 'side'`,
  NUL,
  `${NUL}${SECOND}${NUL}second`,
  '',
  'body line',
  NUL,
  '',
  SECOND_PATCH,
  `${NUL}${SIDE}${NUL}side`,
  NUL,
  '',
  'diff --git s.txt s.txt',
  'new file mode 100644',
  'index 0000000..b478595',
  '--- /dev/null',
  '+++ s.txt',
  '@@ -0,0 +1 @@',
  '+s',
  `${NUL}${FIRST}${NUL}first`,
  NUL,
  '',
  'diff --git a.txt a.txt',
  'new file mode 100644',
  'index 0000000..4cb29ea',
  '--- /dev/null',
  '+++ a.txt',
  '@@ -0,0 +1,3 @@',
  '+one',
  '+two',
  '+three',
  'diff --git old name.txt old name.txt',
  'new file mode 100644',
  'index 0000000..44ab0cb',
  '--- /dev/null',
  '+++ old name.txt\t',
  '@@ -0,0 +1,4 @@',
  '+keep me',
  '+line 2',
  '+line 3',
  '+line 4',
  '',
].join('\n');

describe('PATCH_FLAGS and COMMIT_FORMAT', () => {
  it('ask git for bare added lines with no prefix, and keep every commit of a log', () => {
    assert.deepEqual(PATCH_FLAGS, ['-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-prefix', '--no-relative', '-M']);
    assert.equal(PATCH_FLAGS.some((flag) => flag.startsWith('--diff-filter')), false);
    assert.equal(COMMIT_FORMAT, '--format=%x00%H%x00%B%x00');
  });
});

describe('gitPath', () => {
  it('keeps a path git printed as is', () => {
    for (const path of ['a.txt', 'dir/new name.txt', 'café.txt', '"', '"open', 'close"']) {
      assert.equal(gitPath(path), path);
    }
  });

  it('reads a C-quoted path: named escapes, a quote, a backslash and an unknown escape as its letter', () => {
    assert.equal(gitPath('"a\\tb"'), 'a\tb');
    assert.equal(gitPath('"say \\"hi\\".txt"'), 'say "hi".txt');
    assert.equal(gitPath('"back\\\\slash"'), 'back\\slash');
    assert.equal(gitPath('"\\a\\b\\n\\v\\f\\r"'), '\x07\b\n\v\f\r');
    assert.equal(gitPath('"odd\\q"'), 'oddq');
    assert.equal(gitPath('""'), '');
  });

  it('reads octal bytes as UTF-8', () => {
    assert.equal(gitPath('"caf\\303\\251\\tx.txt"'), 'café\tx.txt');
  });
});

describe('patchAdds', () => {
  it("reads each file's new path and each added line with its number in the new file", () => {
    assert.deepEqual(patchAdds(SECOND_PATCH), {
      paths: ['a.txt', 'k.p12', 'new name.txt', 'p.txt'],
      lines: [
        { file: 'a.txt', line: 2, text: 'TWO' },
        { file: 'a.txt', line: 4, text: 'four' },
        { file: 'new name.txt', line: 3, text: 'line 3 changed' },
        { file: 'p.txt', line: 1, text: '++ plus' },
        { file: 'p.txt', line: 2, text: '+++ x' },
      ],
    });
  });

  it('counts context lines and skips a no-newline note inside a hunk', () => {
    const patch = [
      'diff --git c.txt c.txt',
      '--- c.txt',
      '+++ c.txt',
      '@@ -1,4 +1,4 @@',
      ' keep',
      '-old',
      '\\ No newline at end of file',
      '+new',
      ' tail',
      ' end',
      '@@ -9 +9,2 @@',
      '-nine',
      '+NINE',
      '+ten',
    ].join('\n');
    assert.deepEqual(patchAdds(patch), {
      paths: ['c.txt'],
      lines: [
        { file: 'c.txt', line: 2, text: 'new' },
        { file: 'c.txt', line: 9, text: 'NINE' },
        { file: 'c.txt', line: 10, text: 'ten' },
      ],
    });
  });

  it('adds nothing for a deleted file', () => {
    const patch = [
      'diff --git gone.txt gone.txt',
      'deleted file mode 100644',
      'index 4cb29ea..0000000',
      '--- gone.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
      'diff --git kept.txt kept.txt',
      'new file mode 100644',
      'index 0000000..b478595',
      '--- /dev/null',
      '+++ kept.txt',
      '@@ -0,0 +1 @@',
      '+kept',
    ].join('\n');
    assert.deepEqual(patchAdds(patch), { paths: ['kept.txt'], lines: [{ file: 'kept.txt', line: 1, text: 'kept' }] });
  });

  it('names a moved or copied file by its new path, quoted or not, with or without a content change', () => {
    const patch = [
      'diff --git "old\\tname" "new\\tname"',
      'similarity index 100%',
      'rename from "old\\tname"',
      'rename to "new\\tname"',
      'diff --git src.txt copy.txt',
      'similarity index 100%',
      'copy from src.txt',
      'copy to copy.txt',
      'diff --git "a\\"b" "a\\"c"',
      'similarity index 80%',
      'rename from "a\\"b"',
      'rename to "a\\"c"',
      'index 44ab0cb..654c385 100644',
      '--- "a\\"b"',
      '+++ "a\\"c"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    assert.deepEqual(patchAdds(patch), {
      paths: ['new\tname', 'copy.txt', 'a"c'],
      lines: [{ file: 'a"c', line: 1, text: 'y' }],
    });
  });

  it('names a mode change by its one path, and no path when unequal halves come with neither a move nor a +++ line', () => {
    const patch = [
      'diff --git run me.sh run me.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --git one two three',
      'old mode 100644',
      'new mode 100755',
    ].join('\n');
    assert.deepEqual(patchAdds(patch), { paths: ['run me.sh'], lines: [] });
  });

  it('adds no line from a hunk before any file header, as in a cut or foreign patch', () => {
    const patch = ['index 4cb29ea..657b95b 100644', '@@ -0,0 +1,2 @@', '+orphan', '+lines', '+++ late.txt'].join('\n');
    assert.deepEqual(patchAdds(patch), { paths: [], lines: [] });
  });

  it('adds nothing from an empty patch', () => {
    assert.deepEqual(patchAdds(''), { paths: [], lines: [] });
    assert.deepEqual(patchAdds('\n'), { paths: [], lines: [] });
  });
});

describe('commitsOf', () => {
  it('splits a log into commits, newest first, each with its message and what its patch adds; a merge adds nothing', () => {
    assert.deepEqual(commitsOf(LOG), [
      { sha: MERGE, message: "Merge branch 'side'\n", paths: [], lines: [] },
      { sha: SECOND, message: 'second\n\nbody line\n', ...patchAdds(SECOND_PATCH) },
      { sha: SIDE, message: 'side\n', paths: ['s.txt'], lines: [{ file: 's.txt', line: 1, text: 's' }] },
      {
        sha: FIRST,
        message: 'first\n',
        paths: ['a.txt', 'old name.txt'],
        lines: [
          { file: 'a.txt', line: 1, text: 'one' },
          { file: 'a.txt', line: 2, text: 'two' },
          { file: 'a.txt', line: 3, text: 'three' },
          { file: 'old name.txt', line: 1, text: 'keep me' },
          { file: 'old name.txt', line: 2, text: 'line 2' },
          { file: 'old name.txt', line: 3, text: 'line 3' },
          { file: 'old name.txt', line: 4, text: 'line 4' },
        ],
      },
    ]);
  });

  it('keeps the last commit of a log cut after its id or after its message', () => {
    assert.deepEqual(commitsOf(`${NUL}${FIRST}`), [{ sha: FIRST, message: '', paths: [], lines: [] }]);
    assert.deepEqual(commitsOf(`${NUL}${FIRST}${NUL}first\n`), [{ sha: FIRST, message: 'first\n', paths: [], lines: [] }]);
  });

  it('keeps the lines a cut patch printed', () => {
    const cut = `${NUL}${SIDE}${NUL}side\n${NUL}\n\ndiff --git s.txt s.txt\n--- /dev/null\n+++ s.txt\n@@ -0,0 +1,3 @@\n+s`;
    assert.deepEqual(commitsOf(cut), [
      { sha: SIDE, message: 'side\n', paths: ['s.txt'], lines: [{ file: 's.txt', line: 1, text: 's' }] },
    ]);
  });

  it('reads no commit from an empty log', () => {
    assert.deepEqual(commitsOf(''), []);
  });
});

describe('tagOf', () => {
  it('reads the object a tag points at and the message below its headers, a trailing signature kept', () => {
    const text = [`object ${FIRST}`, 'type commit', 'tag v1', 'tagger A U Thor <thor> 1700000000 +0000', '', 'release one', '', 'body', '-----BEGIN PGP SIGNATURE-----', 'sig', '-----END PGP SIGNATURE-----', ''];
    assert.deepEqual(tagOf(text.join('\n')), { object: FIRST, message: 'release one\n\nbody\n-----BEGIN PGP SIGNATURE-----\nsig\n-----END PGP SIGNATURE-----\n' });
  });

  it('reads a tag of a tag and an empty message, and no tag without an object header', () => {
    assert.deepEqual(tagOf(`object ${SIDE}\ntype tag\ntag outer\n\n`), { object: SIDE, message: '' });
    assert.deepEqual(tagOf(`object ${SIDE}\ntype commit\ntag bare`), { object: SIDE, message: '' });
    assert.equal(tagOf(`type commit\ntag v1\n\nobject ${FIRST}\n`), undefined);
    assert.equal(tagOf(''), undefined);
  });
});

describe('messageLines', () => {
  it('keeps every line of a message without a cut mark', () => {
    assert.deepEqual(messageLines('subject\n\n# a comment\nbody\n'), ['subject', '', '# a comment', 'body', '']);
  });

  it('leaves out the diff a verbose commit puts below the cut mark, whatever the comment character', () => {
    for (const comment of ['#', ';', '//']) {
      const message = ['subject', '', 'body', `${comment} ${CUT}`, '# Do not modify or remove the line above.', '+added'];
      assert.deepEqual(messageLines(message.join('\n')), ['subject', '', 'body'], comment);
    }
  });

  it('keeps a line that only holds the cut mark among other text, as git does', () => {
    const lines = [`see ${CUT} below`, `# ${CUT} trailing`, CUT, ` ${CUT}`, 'body'];
    assert.deepEqual(messageLines(lines.join('\n')), lines);
  });
});
