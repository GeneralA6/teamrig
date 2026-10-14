import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emailFromIdent, parseSignoffs, signoffProblem } from './signoff.ts';

const AUTHOR = 'alpha@example.com';

describe('parseSignoffs', () => {
  it('reads every Signed-off-by trailer', () => {
    const message = 'feat: x\n\nSigned-off-by: Alpha One <alpha@example.com>\nSigned-off-by: Bravo <bravo@example.com>\n';
    assert.deepEqual(parseSignoffs(message), [
      { name: 'Alpha One', email: 'alpha@example.com' },
      { name: 'Bravo', email: 'bravo@example.com' },
    ]);
  });

  it('ignores a sign-off that is not at the start of a line', () => {
    assert.deepEqual(parseSignoffs('see Signed-off-by: Alpha <alpha@example.com> in docs'), []);
  });
});

describe('signoffProblem', () => {
  it("passes a message signed off with the author's e-mail, in any case", () => {
    assert.equal(signoffProblem(AUTHOR, 'x\n\nSigned-off-by: Alpha <ALPHA@example.com>\n'), undefined);
  });

  it('fails a message without a sign-off', () => {
    assert.match(signoffProblem(AUTHOR, 'x\n') ?? '', /no Signed-off-by line; commit with/);
  });

  it("fails a sign-off by someone other than the author", () => {
    assert.match(signoffProblem(AUTHOR, 'x\n\nSigned-off-by: Bravo <bravo@example.com>\n') ?? '', /matches the commit author/);
  });
});

describe('emailFromIdent', () => {
  it('reads the e-mail from a git ident', () => {
    assert.equal(emailFromIdent('Alpha One <alpha@example.com> 1700000000 +0000'), AUTHOR);
  });

  it('rejects an ident without an e-mail', () => {
    assert.throws(() => emailFromIdent('Alpha 1700000000 +0000'), /cannot read an e-mail/);
  });
});
