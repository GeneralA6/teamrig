import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ShellWord } from '../push-guard/tokenizer.ts';
import { GH_ISSUE_WRITES, GH_PR_WRITES, ghWriteOf, type GhWrite } from './gh-writes.ts';

/** The words of a gh call after `gh`; a word holding `$` is only known when it runs. */
function words(line: string): ShellWord[] {
  return line === '' ? [] : line.split(' ').map((text) => ({ text, dynamic: text.includes('$') }));
}

function writeOf(line: string): GhWrite | undefined {
  return ghWriteOf(words(line));
}

describe('ghWriteOf (T2705)', () => {
  it('reads each gh issue and gh pr command that changes an existing one as a write, and no other', () => {
    for (const command of GH_ISSUE_WRITES) {
      assert.deepEqual(writeOf(`issue ${command} 7`), { kind: 'write', what: `gh issue ${command}` });
    }
    for (const command of GH_PR_WRITES) {
      assert.deepEqual(writeOf(`pr ${command} 3`), { kind: 'write', what: `gh pr ${command}` });
    }
    for (const line of ['issue create --title x', 'issue view 7', 'pr create', 'pr checkout 3', 'pr', 'repo view', 'auth status', '']) {
      assert.equal(writeOf(line), undefined, line);
    }
  });

  it('reads a group or command only known when it runs as unreadable, when it may be a write', () => {
    assert.deepEqual(writeOf('pr $DO 3'), { kind: 'unreadable', what: 'gh pr $DO' });
    assert.deepEqual(writeOf('$G close 3'), { kind: 'unreadable', what: 'gh $G close' });
    assert.deepEqual(writeOf('$G $C 3'), { kind: 'unreadable', what: 'gh $G $C' });
    assert.equal(writeOf('$G view 3'), undefined);
    assert.equal(writeOf('$G'), undefined);
  });

  it('reads a gh api call that writes on issues or pull requests, by its method or a body', () => {
    for (const [line, what] of [
      ['api -X PATCH repos/a/b/issues/7 -f state=closed', 'gh api PATCH repos/a/b/issues/7'],
      ['api --method=delete repos/a/b/issues/comments/9', 'gh api DELETE repos/a/b/issues/comments/9'],
      ['api -XPOST repos/a/b/pulls/3/reviews', 'gh api POST repos/a/b/pulls/3/reviews'],
      ['api repos/a/b/issues/7/comments -f body=hi', 'gh api POST repos/a/b/issues/7/comments'],
      ['api repos/a/b/issues/7/labels --input labels.json', 'gh api POST repos/a/b/issues/7/labels'],
      ['api repos/a/b/pulls/3/merge -F merge_method=rebase --paginate', 'gh api POST repos/a/b/pulls/3/merge'],
    ] as const) {
      assert.deepEqual(writeOf(line), { kind: 'write', what }, line);
    }
  });

  it('leaves a gh api read, and a write elsewhere, alone', () => {
    for (const line of [
      'api repos/a/b/pulls/3',
      'api -X GET repos/a/b/issues -f state=open',
      'api repos/a/b/issues --jq .[].number',
      'api -X POST repos/a/b/releases -f tag=v1',
      'api user',
      'api',
      'api $URL',
    ]) {
      assert.equal(writeOf(line), undefined, line);
    }
  });

  it('reads a gh api call whose method or endpoint is only known when it runs as unreadable, on issues', () => {
    assert.deepEqual(writeOf('api -X $M repos/a/b/issues/7'), { kind: 'unreadable', what: 'gh api repos/a/b/issues/7' });
    assert.deepEqual(writeOf('api repos/a/b/issues/7 $FLAGS'), { kind: 'unreadable', what: 'gh api repos/a/b/issues/7' });
    assert.deepEqual(writeOf('api repos/a/b/issues/7 -$F x'), { kind: 'unreadable', what: 'gh api repos/a/b/issues/7' });
    assert.deepEqual(writeOf('api $URL -f body=hi'), { kind: 'unreadable', what: 'gh api $URL' });
    assert.equal(writeOf('api -X'), undefined);
  });

  it('reads a GraphQL call as a write when its body may hold a mutation', () => {
    for (const line of [
      'api graphql -f query=mutation{closeIssue}',
      'api graphql -F query=@q.graphql',
      'api graphql --input q.json',
      'api graphql -f query=$Q',
      'api graphql -X $M -f query={viewer{login}}',
    ]) {
      assert.deepEqual(writeOf(line), { kind: 'write', what: 'gh api graphql' }, line);
    }
    assert.equal(writeOf('api graphql -f query={viewer{login}}'), undefined);
  });
});
