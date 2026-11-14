import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitEnvString, splitGitAlias, type ProgramSplit } from './program-split.ts';

/** A split as its words joined by `|`, a dynamic word marked `~`, or `refused: <reason>`. */
function shown(split: ProgramSplit): string {
  return split.kind === 'refused' ? `refused: ${split.reason}` : split.words.map((word) => (word.dynamic ? `~${word.text}` : word.text)).join('|');
}

describe('splitGitAlias', () => {
  it('splits on whitespace, a CR included, and reads quotes and backslashes as git does', () => {
    const rows: readonly (readonly [string, string])[] = [
      ['push origin main', 'push|origin|main'],
      ['push\r--no-verify', 'push|--no-verify'],
      ['push \t\n origin', 'push|origin'],
      ['commit -m "two words"', 'commit|-m|two words'],
      ["commit -m 'a\\b'", 'commit|-m|a\\b'],
      ['commit -m "a\\"b"', 'commit|-m|a"b'],
      ['push a\\ b', 'push|a b'],
      ['log --format=x$Y;rm', 'log|--format=x$Y;rm'],
      ['push ""', 'push|'],
      [' push', '|push'],
    ];
    for (const [value, expected] of rows) {
      assert.equal(shown(splitGitAlias(value)), expected, JSON.stringify(value));
    }
  });

  it('refuses what git refuses', () => {
    assert.equal(shown(splitGitAlias('push "origin')), 'refused: git refuses an alias value whose quote never closes');
    assert.equal(shown(splitGitAlias('push origin\\')), 'refused: git refuses an alias value that ends in a backslash');
    assert.equal(shown(splitGitAlias("commit -m 'it\\'s'")), 'refused: git refuses an alias value whose quote never closes');
  });
});

describe('splitEnvString', () => {
  it("splits on whitespace, a CR included, and reads quotes, escapes and comments as GNU env's -S does", () => {
    const rows: readonly (readonly [string, string])[] = [
      ['git push origin main', 'git|push|origin|main'],
      ['git push --verify\r--no-verify', 'git|push|--verify|--no-verify'],
      ['git\\_push\\_--no-verify', 'git|push|--no-verify'],
      ['git commit -m "a\\_b"', 'git|commit|-m|a b'],
      ["git commit -m 'a\\_b'", 'git|commit|-m|a\\_b'],
      ["git commit -m 'a\\'b\\\\'", "git|commit|-m|a'b\\"],
      ['git commit -m "a\\tb"', 'git|commit|-m|a\tb'],
      ['git status \\c --no-verify', 'git|status'],
      ['git status #; git push', 'git|status'],
      ['git status a#b', 'git|status|a#b'],
      ['#git push', ''],
      ["git commit -m '#x'", 'git|commit|-m|#x'],
      ['git status;rm x', 'git|status;rm|x'],
      ["git commit -m ''", 'git|commit|-m|'],
      ['git push ${R}', 'git|push|~${R}'],
      ['git push a${R}b', 'git|push|~a${R}b'],
      ["git push '${R}'", 'git|push|${R}'],
      ['', ''],
    ];
    for (const [value, expected] of rows) {
      assert.equal(shown(splitEnvString(value)), expected, JSON.stringify(value));
    }
  });

  it('keeps a variable unsplit, as a quoted part of its word', () => {
    const split = splitEnvString('x${A}y');
    assert.deepEqual(split, {
      kind: 'words',
      words: [
        {
          text: 'x${A}y',
          dynamic: true,
          parts: [
            { kind: 'text', text: 'x', quoted: true },
            { kind: 'variable', name: 'A', quoted: true },
            { kind: 'text', text: 'y', quoted: true },
          ],
        },
      ],
    });
  });

  it('refuses what env refuses', () => {
    const rows: readonly (readonly [string, string])[] = [
      ['git push "origin', 'env -S refuses a quote that never closes'],
      ["git push 'origin", 'env -S refuses a quote that never closes'],
      ['git push \\', 'env -S refuses a backslash at the end of its string'],
      ['git push \\q', 'env -S refuses the escape \\q'],
      ['git commit -m "\\c"', 'env -S refuses \\c inside double quotes'],
      ['git push $R', 'env -S expands only ${NAME}'],
      ['git push ${1}', 'env -S expands only ${NAME}'],
    ];
    for (const [value, reason] of rows) {
      assert.equal(shown(splitEnvString(value)), `refused: ${reason}`, JSON.stringify(value));
    }
  });
});
