import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  blockedByAddArgs,
  GhRefusedError,
  isAllowedGh,
  isIssueClose,
  isIssueComment,
  isIssueCreate,
  isIssueQuery,
  isLabelAdd,
  isLabelRead,
  isLabelRemove,
  isLinkAdd,
  issueCloseArgs,
  issueCommentArgs,
  issueCreateArgs,
  issueLabelAddArgs,
  issueLabelRemoveArgs,
  labelReadArgs,
  nodeGhRunner,
  subIssueAddArgs,
  type IssueNumber,
} from './gh.ts';
import type { IssueDraft } from '../issues/host.ts';
import { CLOSED_ISSUES_QUERY, closedPageArgs, OPEN_ISSUES_QUERY, openPageArgs } from './queries.ts';

const DIR = mkdtempSync(join(tmpdir(), 'teamrig-gh-'));
const ENV = { ...process.env };
/** A first page of acme/web's open issues: a command line the runner starts. */
const READ = openPageArgs({ owner: 'acme', name: 'web', after: undefined });
/** An issue to open; its body holds what a shell or `-F` would read as code or a file, to show it stays text. */
const DRAFT: IssueDraft = { repo: 'acme/web', title: 'Fix login', body: 'Steps: $(x) @file', labels: ['bug', 'p1'] };
/** An issue, or a pull request, to comment on or close. */
const ISSUE: IssueNumber = { repo: 'acme/web', number: 7 };

after(() => rmSync(DIR, { recursive: true, force: true }));

/** A Node script in the temp folder that stands in for gh; returns its path. */
function script(name: string, source: string): string {
  const path = join(DIR, name);
  writeFileSync(path, source);
  return path;
}

describe('isIssueQuery', () => {
  const OPEN = ['api', 'graphql', '-f', `query=${OPEN_ISSUES_QUERY}`];

  it('takes a page of the shipped issue queries', () => {
    const page = { owner: 'acme', name: 'web', after: undefined };
    for (const args of [openPageArgs(page), openPageArgs({ ...page, after: 'Y3Vyc29y' }), closedPageArgs(page, '2030-01-01T00:00:00Z')]) {
      assert.equal(isIssueQuery(args), true, args.slice(4).join(' '));
    }
  });

  it('refuses every other gh command, the issue list teamrig once ran among them', () => {
    for (const args of [['issue', 'list', '-R', 'acme/web'], ['issue', 'close', '7'], ['issue', 'edit', '7'], ['issue', 'comment', '7'], ['api', '-X', 'POST', 'repos/acme/web/issues'], ['label', 'create', 'p1'], ['issue'], []]) {
      assert.equal(isIssueQuery(args), false, args.join(' '));
    }
  });

  it('takes each variable a query declares once, as a raw field', () => {
    assert.equal(isIssueQuery([...OPEN, '-f', 'owner=acme', '-f', 'name=web', '-f', 'after=abc']), true);
    assert.equal(isIssueQuery(['api', 'graphql', '-f', `query=${CLOSED_ISSUES_QUERY}`, '-f', 'owner=acme', '-f', 'since=2030-01-01T00:00:00Z']), true);
    assert.equal(isIssueQuery([...OPEN, '-f', 'owner=a=b; $(x)']), true, 'a value is data: only the key is judged');
  });

  it('refuses any other query, even one a character off', () => {
    for (const query of ['mutation { closeIssue(input: {issueId: "1"}) { clientMutationId } }', `${OPEN_ISSUES_QUERY} `, OPEN_ISSUES_QUERY.replace('first: 100', 'first: 1')]) {
      assert.equal(isIssueQuery(['api', 'graphql', '-f', `query=${query}`]), false, query.slice(0, 40));
    }
  });

  it('refuses a variable the query does not declare, or one given twice', () => {
    assert.equal(isIssueQuery([...OPEN, '-f', 'since=2030-01-01T00:00:00Z']), false);
    assert.equal(isIssueQuery([...OPEN, '-f', 'owner=acme', '-f', 'owner=evil']), false);
    assert.equal(isIssueQuery([...OPEN, '-f', `query=${OPEN_ISSUES_QUERY}`]), false);
  });

  it('refuses every flag but -f, and a field with no key', () => {
    for (const extra of [['-F', 'owner=@secrets.txt'], ['--paginate'], ['-X', 'POST'], ['--input', 'body.json'], ['--hostname', 'evil.example'], ['-f'], ['-f', '=acme'], ['-f', 'owner']]) {
      assert.equal(isIssueQuery([...OPEN, ...extra]), false, extra.join(' '));
    }
    assert.equal(isIssueQuery(['api', 'repos/acme/web/issues', '-f', `query=${OPEN_ISSUES_QUERY}`]), false);
    assert.equal(isIssueQuery(['api', 'graphql']), false);
  });
});

describe('isIssueCreate', () => {
  const CREATE = issueCreateArgs(DRAFT);

  it('takes the command line issueCreateArgs builds, with no labels or several', () => {
    assert.deepEqual(CREATE, ['api', 'repos/acme/web/issues', '-X', 'POST', '-f', 'title=Fix login', '-f', 'body=Steps: $(x) @file', '-f', 'labels[]=bug', '-f', 'labels[]=p1']);
    assert.equal(isIssueCreate(CREATE), true);
    assert.equal(isIssueCreate(issueCreateArgs({ ...DRAFT, labels: [] })), true);
    assert.equal(isIssueCreate(issueCreateArgs({ ...DRAFT, repo: 'acme-co/web.site_2' })), true);
  });

  it('refuses any path but one repository\'s issues: an issue, its comments, another API', () => {
    for (const path of ['repos/acme/web/issues/7', 'repos/acme/web/issues/7/comments', 'repos/acme/issues', 'repos/acme/web/x/issues', 'repos/../web/issues', 'repos/acme/../issues', 'repos/acme/./issues', 'user/repos', 'repos/acme/web/labels']) {
      assert.equal(isIssueCreate(['api', path, ...CREATE.slice(2)]), false, path);
    }
  });

  it('refuses another method, a flag but -f, and any field out of place', () => {
    const fields = CREATE.slice(4);
    for (const args of [
      ['api', 'repos/acme/web/issues', '-X', 'PATCH', ...fields],
      ['api', 'repos/acme/web/issues', ...fields],
      [...CREATE, '-F', 'labels[]=x'],
      [...CREATE, '--input', 'file.json'],
      [...CREATE, '-f', 'assignees[]=octocat'],
      [...CREATE, '-f', 'title=Again'],
      ['api', 'repos/acme/web/issues', '-X', 'POST', '-f', 'body=b', '-f', 'title=t'],
      ['api', 'repos/acme/web/issues', '-X', 'POST', '-f', 'title=t'],
      ['api', 'repos/acme/web/issues', '-X', 'POST', '-f', 'title=t', '-f', 'body=b', '-f', 'milestone=1'],
    ]) {
      assert.equal(isIssueCreate(args), false, args.slice(4).join(' '));
    }
  });

  it('is never taken for a query, nor a query for a create', () => {
    assert.equal(isIssueCreate(READ), false);
    assert.equal(isIssueQuery(CREATE), false);
  });
});

describe('isIssueComment', () => {
  const COMMENT = issueCommentArgs(ISSUE, 'Thanks: $(x) @file state=closed');

  it('takes the command line issueCommentArgs builds, its body kept as text', () => {
    assert.deepEqual(COMMENT, ['api', 'repos/acme/web/issues/7/comments', '-X', 'POST', '-f', 'body=Thanks: $(x) @file state=closed']);
    assert.equal(isIssueComment(COMMENT), true);
    assert.equal(isIssueComment(issueCommentArgs({ repo: 'acme-co/web.site_2', number: 1234567890 }, '')), true);
  });

  it("refuses any path but one issue's comments", () => {
    for (const path of ['repos/acme/web/issues/7', 'repos/acme/web/issues/comments', 'repos/acme/web/issues/0/comments', 'repos/acme/web/issues/07/comments', 'repos/acme/web/issues/12345678901/comments', 'repos/acme/web/pulls/7/comments', 'repos/acme/web/issues/7/comments/9', 'repos/acme/web/issues/comments/9', 'repos/acme/../issues/7/comments', 'repos/acme/web/x/issues/7/comments']) {
      assert.equal(isIssueComment(['api', path, ...COMMENT.slice(2)]), false, path);
    }
  });

  it('refuses another method, a flag but -f, and any field but one body', () => {
    for (const args of [
      ['api', 'repos/acme/web/issues/7/comments', '-X', 'PATCH', '-f', 'body=b'],
      ['api', 'repos/acme/web/issues/7/comments', '-f', 'body=b'],
      ['api', 'repos/acme/web/issues/7/comments', '-X', 'POST', '-F', 'body=@file'],
      ['api', 'repos/acme/web/issues/7/comments', '-X', 'POST'],
      [...COMMENT, '-f', 'body=again'],
      [...COMMENT, '--input', 'file.json'],
      ['api', 'repos/acme/web/issues/7/comments', '-X', 'POST', '-f', 'title=t'],
    ]) {
      assert.equal(isIssueComment(args), false, args.slice(2).join(' '));
    }
  });
});

describe('isIssueClose', () => {
  const CLOSE = issueCloseArgs(ISSUE);

  it('takes the command line issueCloseArgs builds', () => {
    assert.deepEqual(CLOSE, ['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'state=closed']);
    assert.equal(isIssueClose(CLOSE), true);
  });

  it('takes a close with each reason, in the word GitHub uses for it', () => {
    assert.deepEqual(issueCloseArgs(ISSUE, 'not-planned').slice(-2), ['-f', 'state_reason=not_planned']);
    for (const reason of ['completed', 'not-planned', 'duplicate'] as const) {
      assert.equal(isIssueClose(issueCloseArgs(ISSUE, reason)), true, reason);
    }
  });

  it('refuses a reopen, any other field, reason, method, flag or path', () => {
    for (const args of [
      ['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'state=open'],
      ['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'state=open', '-f', 'state_reason=reopened'],
      ['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'state=closed', '-f', 'state_reason=reopened'],
      ['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'state=closed', '-f', 'state_reason=not-planned'],
      ['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'state=closed', '-f', 'state_reason=completed', '-f', 'title=t'],
      ['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'state_reason=completed', '-f', 'state=closed'],
      ['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'state=closed', '-f', 'duplicate_issue_id=1'],
      ['api', 'repos/acme/web/issues/7/labels', '-X', 'PATCH', '-f', 'state=closed'],
      ['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'title=t'],
      ['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-F', 'state=closed'],
      ['api', 'repos/acme/web/issues/7', '-X', 'DELETE', '-f', 'state=closed'],
      ['api', 'repos/acme/web/issues/7', '-f', 'state=closed'],
      ['api', 'repos/acme/web/issues/7/comments', '-X', 'PATCH', '-f', 'state=closed'],
      ['api', 'repos/acme/web/pulls/7/merge', '-X', 'PATCH', '-f', 'state=closed'],
      ['api', 'repos/acme/web/issues', '-X', 'PATCH', '-f', 'state=closed'],
    ]) {
      assert.equal(isIssueClose(args), false, args.slice(1).join(' '));
    }
  });

  it('is never taken for a comment, a create or a query, nor they for a close', () => {
    assert.ok([READ, issueCreateArgs(DRAFT), issueCommentArgs(ISSUE, 'b')].every((args) => !isIssueClose(args)));
    assert.ok([READ, issueCreateArgs(DRAFT), CLOSE].every((args) => !isIssueComment(args)));
    assert.ok(!isIssueCreate(CLOSE) && !isIssueQuery(CLOSE) && !isIssueCreate(issueCommentArgs(ISSUE, 'b')));
  });
});

describe('the label calls', () => {
  const ADD = issueLabelAddArgs(ISSUE, ['type: bug', 'p1']);
  const REMOVE = issueLabelRemoveArgs(ISSUE, 'needs triage');

  it('takes the command lines the label builders make, a name with a space, slash or hash kept in one path segment', () => {
    assert.deepEqual(ADD, ['api', 'repos/acme/web/issues/7/labels', '-X', 'POST', '-f', 'labels[]=type: bug', '-f', 'labels[]=p1']);
    assert.deepEqual(REMOVE, ['api', 'repos/acme/web/issues/7/labels/needs%20triage', '-X', 'DELETE']);
    assert.deepEqual(labelReadArgs('acme/web', 'a/b#c?'), ['api', 'repos/acme/web/labels/a%2Fb%23c%3F']);
    assert.equal(isLabelAdd(ADD), true);
    assert.equal(isLabelRemove(REMOVE), true);
    assert.equal(isLabelRemove(issueLabelRemoveArgs(ISSUE, '../../../x')), true, 'encoded, the dots stay inside the segment');
    assert.equal(isLabelRead(labelReadArgs('acme/web', 'a/b#c?')), true);
    assert.ok([ADD, REMOVE, labelReadArgs('acme/web', 'p1')].every(isAllowedGh));
  });

  it('refuses a label add with no label, another field, flag or method, or a replace of every label', () => {
    for (const args of [
      ['api', 'repos/acme/web/issues/7/labels', '-X', 'POST'],
      ['api', 'repos/acme/web/issues/7/labels', '-X', 'PUT', '-f', 'labels[]=p1'],
      ['api', 'repos/acme/web/issues/7/labels', '-X', 'POST', '-f', 'labels[]=p1', '-f', 'name=p2'],
      ['api', 'repos/acme/web/issues/7/labels', '-X', 'POST', '-F', 'labels[]=@file'],
      ['api', 'repos/acme/web/issues/7/labels', '-X', 'DELETE'],
      ['api', 'repos/acme/web/labels', '-X', 'POST', '-f', 'labels[]=p1'],
      ['api', 'repos/acme/web/issues/7/comments', '-X', 'POST', '-f', 'labels[]=p1'],
    ]) {
      assert.equal(isLabelAdd(args), false, args.slice(1).join(' '));
    }
  });

  it('takes a label segment only in the spelling encodeURIComponent gives, so no escape decodes to a step up the path', () => {
    for (const segment of ['%2E%2E', '%2E', '.%2E', '%41', '%E0%A4', '%2e%2E']) {
      assert.equal(isLabelRemove(['api', `repos/acme/web/issues/7/labels/${segment}`, '-X', 'DELETE']), false, segment);
      assert.equal(isLabelRead(['api', `repos/acme/web/labels/${segment}`]), false, segment);
    }
    for (const name of ['needs triage', 'type: bug', 'a/b', 'ü', '..x']) {
      assert.ok(isLabelRemove(issueLabelRemoveArgs({ repo: 'acme/web', number: 7 }, name)), name);
      assert.ok(isLabelRead(labelReadArgs('acme/web', name)), name);
    }
  });

  it("refuses a remove that steps out of the label's segment, carries a field or flag, or deletes the repository's label", () => {
    for (const args of [
      ['api', 'repos/acme/web/issues/7/labels/..', '-X', 'DELETE'],
      ['api', 'repos/acme/web/issues/7/labels/.', '-X', 'DELETE'],
      ['api', 'repos/acme/web/issues/7/labels/a b', '-X', 'DELETE'],
      ['api', 'repos/acme/web/issues/7/labels/a%2fb', '-X', 'DELETE'],
      ['api', 'repos/acme/web/issues/7/labels/p1', '-X', 'DELETE', '-f', 'name=p1'],
      ['api', 'repos/acme/web/issues/7/labels/p1', '-X', 'POST'],
      ['api', 'repos/acme/web/labels/p1', '-X', 'DELETE'],
      ['api', 'repos/../web/issues/7/labels/p1', '-X', 'DELETE'],
    ]) {
      assert.equal(isLabelRemove(args), false, args.slice(1).join(' '));
    }
  });

  it("refuses a label read that creates, edits or deletes it, or reads another path", () => {
    for (const args of [
      ['api', 'repos/acme/web/labels/p1', '-X', 'PATCH', '-f', 'name=p2'],
      ['api', 'repos/acme/web/labels/p1', '-X', 'DELETE'],
      ['api', 'repos/acme/web/labels', '-X', 'POST', '-f', 'name=p1'],
      ['api', 'repos/acme/web/labels'],
      ['api', 'repos/acme/web/labels/..'],
      ['api', 'repos/acme/web/labels/p1/x'],
      ['api', 'repos/acme/web/issues/7/labels/p1'],
      ['api', 'repos/acme/web/labels/p1', '--hostname', 'example.com'],
    ]) {
      assert.equal(isLabelRead(args), false, args.slice(1).join(' '));
      assert.equal(isAllowedGh(args), false, args.slice(1).join(' '));
    }
  });

  it('is never taken for a comment, a close, a create or a query, nor they for a label call', () => {
    for (const args of [ADD, REMOVE, labelReadArgs('acme/web', 'p1')]) {
      assert.ok(!isIssueClose(args) && !isIssueComment(args) && !isIssueCreate(args) && !isIssueQuery(args), args[1]);
    }
    for (const args of [READ, issueCreateArgs(DRAFT), issueCommentArgs(ISSUE, 'b'), issueCloseArgs(ISSUE, 'duplicate')]) {
      assert.ok(!isLabelAdd(args) && !isLabelRemove(args) && !isLabelRead(args), args[1]);
    }
  });
});

describe('isLinkAdd', () => {
  const SUB = subIssueAddArgs(ISSUE, 3012345678);
  const BLOCKED = blockedByAddArgs(ISSUE, 3012345679);

  it('takes the command lines subIssueAddArgs and blockedByAddArgs build, each id a typed field of digits', () => {
    assert.deepEqual(SUB, ['api', 'repos/acme/web/issues/7/sub_issues', '-X', 'POST', '-F', 'sub_issue_id=3012345678']);
    assert.deepEqual(BLOCKED, ['api', 'repos/acme/web/issues/7/dependencies/blocked_by', '-X', 'POST', '-F', 'issue_id=3012345679']);
    assert.equal(isLinkAdd(SUB), true);
    assert.equal(isLinkAdd(BLOCKED), true);
    assert.equal(isLinkAdd(subIssueAddArgs({ repo: 'acme-co/web.site_2', number: 1234567890 }, 999999999999999)), true);
  });

  it("refuses an id of anything but 1 to 15 digits, or another endpoint's key", () => {
    for (const field of ['sub_issue_id=@file', 'sub_issue_id=', 'sub_issue_id=0', 'sub_issue_id=012', 'sub_issue_id=1e3', 'sub_issue_id=-1', 'sub_issue_id=12 ', 'sub_issue_id=1000000000000000', 'issue_id=12', 'sub_issue_id', '=12', 'replace_parent=true']) {
      assert.equal(isLinkAdd([...SUB.slice(0, 5), field]), false, field);
    }
    assert.equal(isLinkAdd([...BLOCKED.slice(0, 5), 'sub_issue_id=12']), false);
  });

  it('refuses another method, a raw field, an extra field or flag, and any other path', () => {
    for (const args of [
      ['api', SUB[1] ?? '', '-X', 'DELETE', '-F', 'sub_issue_id=12'],
      ['api', SUB[1] ?? '', '-X', 'PATCH', '-F', 'sub_issue_id=12'],
      ['api', SUB[1] ?? '', '-X', 'POST', '-f', 'sub_issue_id=12'],
      ['api', SUB[1] ?? '', '-F', 'sub_issue_id=12'],
      [...SUB, '-F', 'replace_parent=true'],
      [...BLOCKED, '--input', 'file.json'],
      ['graphql', ...SUB.slice(1)],
    ]) {
      assert.equal(isLinkAdd(args), false, args.slice(1).join(' '));
    }
    for (const path of ['repos/acme/web/issues/7/sub_issues/priority', 'repos/acme/web/issues/7/sub_issue', 'repos/acme/web/issues/7/dependencies/blocking', 'repos/acme/web/issues/7/dependencies/blocked_by/9', 'repos/acme/web/issues/0/sub_issues', 'repos/acme/web/issues/07/sub_issues', 'repos/acme/../issues/7/sub_issues', 'repos/acme/web/pulls/7/sub_issues', 'repos/acme/web/x/issues/7/sub_issues']) {
      assert.equal(isLinkAdd(['api', path, ...SUB.slice(2)]), false, path);
    }
  });

  it('is never taken for a query, create, comment, close or label call, nor they for a link, and the runner starts it', () => {
    const others = [READ, issueCreateArgs(DRAFT), issueCommentArgs(ISSUE, 'b'), issueCloseArgs(ISSUE), issueLabelAddArgs(ISSUE, ['p1']), issueLabelRemoveArgs(ISSUE, 'p1'), labelReadArgs('acme/web', 'p1')];
    assert.ok(others.every((args) => !isLinkAdd(args)));
    assert.ok([SUB, BLOCKED].every((args) => !isIssueQuery(args) && !isIssueCreate(args) && !isIssueComment(args) && !isIssueClose(args)));
    assert.ok([SUB, BLOCKED].every((args) => !isLabelAdd(args) && !isLabelRemove(args) && !isLabelRead(args)));
    assert.ok([SUB, BLOCKED].every(isAllowedGh));
  });
});

describe('nodeGhRunner', () => {
  it('passes each argument as a list item, never through a shell, and tells gh not to prompt', async () => {
    const gh = script('echo-args.mjs', 'process.stdout.write(JSON.stringify([process.argv.slice(2), process.env.GH_PROMPT_DISABLED]));');
    const args = openPageArgs({ owner: 'acme', name: 'a;b $(x) "q" | y', after: undefined });
    const result = await nodeGhRunner(process.execPath, [gh]).run({ args, env: ENV });
    assert.deepEqual(result.end, { kind: 'exited', code: 0 });
    assert.deepEqual(JSON.parse(result.stdout), [args, '1']);
  });

  it('refuses a command line that is not a page of a shipped query, and starts nothing', async () => {
    const marker = join(DIR, 'started');
    const gh = script('mark.cjs', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');`);
    for (const args of [['issue', 'close', '7'], ['issue', 'list', '-R', 'acme/web'], [...READ, '--paginate']]) {
      await assert.rejects(nodeGhRunner(process.execPath, [gh]).run({ args, env: ENV }), GhRefusedError, args.join(' ').slice(0, 40));
    }
    await assert.rejects(
      nodeGhRunner(process.execPath, [gh]).run({ args: ['issue', 'close', '7'], env: ENV }),
      /teamrig only runs gh for its shipped issue queries and to open, comment on, label, close or link an issue: it refuses gh issue close with these arguments/,
    );
    assert.equal(existsSync(marker), false);
  });

  it('starts the creation of one issue, one comment on or the close of one issue, and one link added', async () => {
    const gh = script('echo-create.mjs', 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    for (const args of [issueCreateArgs(DRAFT), issueCommentArgs(ISSUE, 'a;b $(x) | y'), issueCloseArgs(ISSUE), subIssueAddArgs(ISSUE, 42), blockedByAddArgs(ISSUE, 43)]) {
      const result = await nodeGhRunner(process.execPath, [gh]).run({ args, env: ENV });
      assert.deepEqual(JSON.parse(result.stdout), args);
    }
  });

  it('keeps stdout and stderr apart, with the exit code', async () => {
    const gh = script('fail.mjs', "process.stdout.write('out'); console.error('To get started with GitHub CLI, please run:  gh auth login'); process.exit(4);");
    const result = await nodeGhRunner(process.execPath, [gh]).run({ args: READ, env: ENV });
    assert.deepEqual(result, { end: { kind: 'exited', code: 4 }, stdout: 'out', stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' });
  });

  it('rejects with ENOENT when gh is not installed', async () => {
    await assert.rejects(nodeGhRunner(join(DIR, 'no-such-gh')).run({ args: READ, env: ENV }), { code: 'ENOENT' });
  });

  it('stops a run that outlives its time, and says so by the signal', async () => {
    const gh = script('hang.mjs', 'setTimeout(() => {}, 30_000);');
    const result = await nodeGhRunner(process.execPath, [gh], 300).run({ args: READ, env: ENV });
    assert.equal(result.end.kind, 'signal');
  });
});
