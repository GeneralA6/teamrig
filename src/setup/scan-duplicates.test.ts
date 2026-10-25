import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DUPLICATE_MIN_CHARS, findDuplicates, normalUnit } from './scan-duplicates.ts';

const RULE = 'Never commit straight to the main branch of any repository.';

describe('normalUnit', () => {
  it('drops list markers, numbering, case, extra spaces and closing punctuation', () => {
    assert.equal(normalUnit(`- ${RULE}`), normalUnit(`2)   never commit straight to the MAIN branch of any   repository!`));
    assert.equal(normalUnit('## Heading here.'), 'heading here');
  });
});

describe('findDuplicates', () => {
  it('names each later repeat of a line or sentence with where it was first, in another file or the same one', () => {
    const found = findDuplicates([
      { path: 'a.md', text: `# Rules\n- ${RULE}\nKeep commits small. Run every test before a push to the remote.` },
      { path: 'b.md', text: `1. ${RULE.toUpperCase()}\r\nIntro line. run every test before a push to the remote!\n* ${RULE}` },
    ]);
    assert.deepEqual(found, [
      { path: 'b.md', line: 1, text: RULE.toUpperCase(), firstPath: 'a.md', firstLine: 2 },
      { path: 'b.md', line: 2, text: 'run every test before a push to the remote!', firstPath: 'a.md', firstLine: 3 },
      { path: 'b.md', line: 3, text: RULE, firstPath: 'a.md', firstLine: 2 },
    ]);
  });

  it(`counts no unit shorter than ${DUPLICATE_MIN_CHARS} characters once normalized`, () => {
    const short = 'x'.repeat(DUPLICATE_MIN_CHARS - 1);
    const long = 'y'.repeat(DUPLICATE_MIN_CHARS);
    const found = findDuplicates([{ path: 'a.md', text: [short, short, `- ${long}.`, long].join('\n') }]);
    assert.deepEqual(
      found.map((duplicate) => [duplicate.line, duplicate.firstLine]),
      [[4, 3]],
    );
  });
});
